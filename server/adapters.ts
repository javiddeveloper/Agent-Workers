// Provider adapters: run one conversational turn of a CLI agent headlessly and translate
// its output into LogEvents. Each provider keeps its own conversation via a session id.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig, PermissionLevel, ProviderId, TurnEmit, TurnResult } from './types.ts';

export const ACCOUNTS_DIR = process.env.AGENT_WORKERS_ACCOUNTS || path.join(os.homedir(), '.agent-workers', 'accounts');

export interface TurnInput {
  agent: AgentConfig;
  prompt: string;
  systemPrompt: string;
  sessionId?: string;
  signal: AbortSignal;
  emit: TurnEmit;
}

export interface Adapter {
  id: ProviderId;
  label: string;
  /** Suggestions only; any model string the CLI accepts works. */
  models: string[];
  /** True when the CLI takes a system prompt flag; otherwise the orchestrator prepends it to the first message. */
  systemPromptFlag: boolean;
  runTurn(input: TurnInput): Promise<TurnResult>;
  /** Interactive command used for the sign-in terminal. */
  loginCommand(agent: AgentConfig): string[];
}

// ---------- environment ----------

export function accountEnv(agent: AgentConfig): Record<string, string> {
  const account = (agent.account || '').trim();
  if (!account || account === 'default') return {};
  const base = path.join(ACCOUNTS_DIR, account.replace(/[^a-zA-Z0-9._-]/g, '_'));
  let env: Record<string, string> = {};
  if (agent.provider === 'claude') env = { CLAUDE_CONFIG_DIR: path.join(base, 'claude') };
  else if (agent.provider === 'gemini') env = { GEMINI_CLI_HOME: path.join(base, 'gemini') };
  // agy has no config-dir variable; a separate HOME keeps its ~/.gemini/antigravity-cli apart.
  else if (agent.provider === 'antigravity') env = { HOME: path.join(base, 'antigravity') };
  for (const dir of Object.values(env)) fs.mkdirSync(dir, { recursive: true });
  return env;
}

export function agentEnv(agent: AgentConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Never leak the variables of a Claude session that launched this server into the agents.
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE') || key === '__CFBundleIdentifier') delete env[key];
  return { ...env, ...accountEnv(agent), NO_COLOR: '1', FORCE_COLOR: '0' };
}

export function agentCwd(agent: AgentConfig): string {
  // No silent fallback to another folder: the agent would read and write somewhere unexpected.
  if (!agent.cwd || !fs.existsSync(agent.cwd)) throw new Error(`folder not found: ${agent.cwd || '(none)'}`);
  return agent.cwd;
}

// ---------- process helper ----------

interface RunOptions {
  agent: AgentConfig;
  args: string[];
  signal: AbortSignal;
  onLine?: (line: string) => void;
}

const running = new Set<number>();

function killGroup(pid: number) {
  try { process.kill(-pid, 'SIGTERM'); } catch {}
}

/** Kills every agent process still running (used on shutdown). */
export function killAllProcesses() {
  for (const pid of running) killGroup(pid);
}

/** Runs `cmd args` through the user's login shell (so PATH matches their terminal). */
function runProcess({ agent, args, signal, onLine }: RunOptions): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const child = spawn(shell, ['-l', '-c', 'exec "$@"', 'agent', ...args], {
      cwd: agentCwd(agent),
      env: agentEnv(agent),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so stopping also kills helpers the CLI spawns (Gemini re-execs itself).
      detached: true,
    });
    running.add(child.pid!);
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!onLine) return;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-20000); });
    const abort = () => killGroup(child.pid!);
    signal.addEventListener('abort', abort, { once: true });
    child.on('close', (code) => {
      running.delete(child.pid!);
      signal.removeEventListener('abort', abort);
      if (onLine && pending.trim()) onLine(pending);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

function parseJson(line: string): any {
  try { return JSON.parse(line); } catch { return null; }
}

const clip = (s: string, n = 1500) => (s.length > n ? s.slice(0, n) + ` … (+${s.length - n} chars)` : s);

/** One-line summary of a tool call's input for the console. */
function summarizeInput(input: any): string {
  if (!input || typeof input !== 'object') return String(input ?? '');
  const key = ['command', 'file_path', 'path', 'dir_path', 'pattern', 'url', 'query', 'description', 'prompt'].find((k) => input[k]);
  return clip(key ? String(input[key]) : JSON.stringify(input), 300);
}

function toolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content ?? '');
}

// ---------- Claude Code ----------

// "dontAsk" refuses anything not pre-approved, which is what read-only means for a headless agent.
// (--allowedTools is variadic, so it must be followed by another flag.)
const CLAUDE_PERMISSION: Record<PermissionLevel, string[]> = {
  readonly: ['--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  edit: ['--permission-mode', 'acceptEdits'],
  auto: ['--permission-mode', 'auto'],
  full: ['--permission-mode', 'bypassPermissions'],
};

/** Reads Claude Code's stream-json output line by line. */
export function claudeStreamParser(emit: TurnEmit, sessionId?: string) {
  const state = { sessionId, finalText: '', texts: [] as string[], cost: undefined as number | undefined, tokens: undefined as number | undefined, isError: false };
  function onLine(line: string) {
    const ev = parseJson(line);
    if (!ev) return;
    if (ev.session_id) state.sessionId = ev.session_id;
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text.trim()) { state.texts.push(c.text); emit({ kind: 'text', text: c.text }); }
        else if (c.type === 'thinking' && c.thinking?.trim()) emit({ kind: 'thinking', text: clip(c.thinking, 600) });
        else if (c.type === 'tool_use') emit({ kind: 'tool', from: c.name, text: summarizeInput(c.input) });
      }
    } else if (ev.type === 'user') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'tool_result') emit({ kind: 'tool_result', text: clip(toolResultText(c.content), 800), meta: { error: !!c.is_error } });
      }
    } else if (ev.type === 'result') {
      state.finalText = typeof ev.result === 'string' ? ev.result : state.texts.at(-1) ?? '';
      state.cost = ev.total_cost_usd;
      const u = ev.usage ?? {};
      state.tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      state.isError = !!ev.is_error;
    }
  }
  return { onLine, state };
}

const claude: Adapter = {
  id: 'claude',
  label: 'Claude Code',
  models: ['opus', 'sonnet', 'haiku'],
  systemPromptFlag: true,
  loginCommand: () => ['claude'],
  async runTurn({ agent, prompt, systemPrompt, sessionId, signal, emit }) {
    const args = ['claude', ...CLAUDE_PERMISSION[agent.permission], '-p', '--output-format', 'stream-json', '--verbose'];
    if (agent.model) args.push('--model', agent.model);
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (sessionId) args.push('--resume', sessionId);
    args.push('--', prompt);

    const parser = claudeStreamParser(emit, sessionId);
    const { code, stderr } = await runProcess({ agent, args, signal, onLine: parser.onLine });
    const { state } = parser;
    const finalText = state.finalText || state.texts.at(-1) || '';
    const ok = code === 0 && !state.isError;
    return {
      sessionId: state.sessionId, finalText, allText: state.texts.join('\n\n'), costUsd: state.cost, tokens: state.tokens, ok,
      error: ok ? undefined : clip(state.finalText || stderr.trim() || `exit code ${code}`, 800),
    };
  },
};

// ---------- Gemini CLI ----------

// Headless Gemini drops tools that would need approval, so "default" is read-only without
// the plan-mode ritual (plan files, plan approval) that "plan" adds to every turn.
const GEMINI_APPROVAL: Record<PermissionLevel, string> = {
  readonly: 'default',
  edit: 'auto_edit',
  auto: 'yolo',
  full: 'yolo',
};

const gemini: Adapter = {
  id: 'gemini',
  label: 'Gemini CLI',
  models: ['auto', 'gemini-3.5-pro', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
  systemPromptFlag: false,
  loginCommand: () => ['gemini'],
  async runTurn({ agent, prompt, sessionId, signal, emit }) {
    // Gemini resumes by the id we choose up front.
    const id = sessionId ?? crypto.randomUUID();
    const args = ['gemini', '-o', 'stream-json', '--skip-trust', '--approval-mode', GEMINI_APPROVAL[agent.permission]];
    if (agent.model && agent.model !== 'auto') args.push('-m', agent.model);
    if (agent.sandbox) args.push('--sandbox');
    args.push(sessionId ? '--resume' : '--session-id', id);
    args.push('-p', prompt);

    let buffer = '';
    let finalText = '';
    const texts: string[] = [];
    let tokens: number | undefined;
    let failed = '';
    const flush = () => {
      if (buffer.trim()) { emit({ kind: 'text', text: buffer }); finalText = buffer; texts.push(buffer); }
      buffer = '';
    };
    const { code, stderr } = await runProcess({
      agent, args, signal,
      onLine(line) {
        const ev = parseJson(line);
        if (!ev) return;
        if (ev.type === 'message' && ev.role === 'assistant') {
          buffer += ev.content ?? '';
        } else if (ev.type === 'tool_use') {
          flush();
          emit({ kind: 'tool', from: ev.tool_name, text: summarizeInput(ev.parameters) });
        } else if (ev.type === 'tool_result') {
          emit({ kind: 'tool_result', text: clip(String(ev.output ?? ev.error?.message ?? ''), 800), meta: { error: ev.status !== 'success' } });
        } else if (ev.type === 'result') {
          flush();
          tokens = ev.stats?.total_tokens;
          if (ev.status !== 'success') failed = ev.error?.message || 'Gemini reported an error';
        } else if (ev.type === 'error') {
          failed = ev.message || ev.error?.message || 'Gemini error';
        }
      },
    });
    flush();
    const ok = code === 0 && !failed;
    return { sessionId: id, finalText, allText: texts.join('\n\n'), tokens, ok, error: ok ? undefined : clip(failed || stderr.trim() || `exit code ${code}`, 800) };
  },
};

// ---------- Antigravity CLI (agy) ----------

const antigravity: Adapter = {
  id: 'antigravity',
  label: 'Antigravity',
  models: [],
  systemPromptFlag: false,
  loginCommand: () => ['agy'],
  async runTurn({ agent, prompt, sessionId, signal, emit }) {
    // agy --print only returns plain text. A conversation id, when it reports one, lets us resume.
    const args = ['agy', '--print', prompt, '--print-timeout', '30m'];
    if (agent.model) args.push('--model', agent.model);
    if (agent.permission === 'auto' || agent.permission === 'full') args.push('--dangerously-skip-permissions');
    if (agent.sandbox) args.push('--sandbox');
    if (sessionId) args.push('--conversation', sessionId);
    const { code, stdout, stderr } = await runProcess({ agent, args, signal });
    const text = stdout.trim();
    const idMatch = (stdout + '\n' + stderr).match(/conversation[ _-]?id[^0-9a-f]{1,4}([0-9a-f][0-9a-f-]{7,})/i);
    if (text) emit({ kind: 'text', text });
    const ok = code === 0;
    return { sessionId: idMatch?.[1] ?? sessionId, finalText: text, ok, error: ok ? undefined : clip(stderr.trim() || text || `exit code ${code}`, 800) };
  },
};

// ---------- Custom command ----------

const custom: Adapter = {
  id: 'custom',
  label: 'Custom command',
  models: [],
  systemPromptFlag: false,
  loginCommand: (agent) => (agent.command || '').split(/\s+/).filter((p) => p && !p.includes('{prompt}')).slice(0, 1),
  async runTurn({ agent, prompt, signal, emit }) {
    const template = agent.command || '';
    const parts = template.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    // {prompt} may sit inside an argument too, e.g. --message={prompt}.
    const args = parts.map((p) => p.replace(/^["']|["']$/g, '')).map((p) => p.replaceAll('{prompt}', () => prompt));
    if (!template.includes('{prompt}')) args.push(prompt);
    const { code, stdout, stderr } = await runProcess({ agent, args, signal });
    const text = stdout.trim();
    if (text) emit({ kind: 'text', text });
    const ok = code === 0;
    return { finalText: text, ok, error: ok ? undefined : clip(stderr.trim() || `exit code ${code}`, 800) };
  },
};

export const ADAPTERS: Record<ProviderId, Adapter> = { claude, gemini, antigravity, custom };
