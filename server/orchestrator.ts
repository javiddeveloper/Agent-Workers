// The orchestrator for one project: an inbox per agent, one turn at a time per agent, and
// routing of tasks, results and messages between agents based on the tags in their replies.
// Every project has its own orchestrator, so each keeps its own conversations, tasks and log.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS } from './adapters.ts';
import { createCheckpoint } from './checkpoints.ts';
import { describeAgent, parseBlocked, parseDirectives, stripDirectives, systemPrompt } from './prompts.ts';
import { readJson, writeJson, type AgentStore } from './store.ts';
import type { AgentConfig, AgentRuntime, AgentView, LogEvent, Project, RoleId, Task, TaskStatus, TurnResult } from './types.ts';

interface InboxItem {
  kind: 'user' | 'task' | 'result' | 'message';
  from: string;
  text: string;
  taskId?: number;
}

interface Runtime extends AgentRuntime {
  queue: InboxItem[];
  abort?: AbortController;
  /** Tasks in the turn that is running now. */
  currentTasks: number[];
  /** System prompt this conversation last received, for CLIs that only get it inside a message. */
  promptSent?: string;
}

const MAX_EVENTS_IN_MEMORY = 3000;
/** Agent turns allowed without a new user message, so a team can't loop forever on your quota. */
const DEFAULT_AUTO_TURN_BUDGET = 60;
const CAN_DELEGATE: RoleId[] = ['lead', 'custom'];

export class Orchestrator extends EventEmitter {
  tasks: Task[] = [];
  events: LogEvent[] = [];
  paused = false;
  autoTurns = 0;
  autoTurnBudget = DEFAULT_AUTO_TURN_BUDGET;
  private runtime = new Map<string, Runtime>();
  private nextEventId = 1;
  private nextTaskId = 1;
  /** For each delegating agent: the team members it was last told about. */
  private teamSeen: Record<string, string[]> = {};

  constructor(public project: Project, private team: AgentStore, private dataDir: string) {
    super();
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  get agents(): AgentConfig[] { return this.team.list; }

  // ---------- persistence ----------

  private file(name: string) { return path.join(this.dataDir, name); }

  private load() {
    const board = readJson<{ nextId: number; tasks: Task[] }>(this.file('tasks.json'), { nextId: 1, tasks: [] });
    this.tasks = board.tasks.map((t) => ({
      ...t,
      // Work in flight when the server stopped does not resume by itself.
      status: t.status === 'working' || t.status === 'queued' ? 'cancelled' : t.status,
    }));
    this.nextTaskId = Math.max(board.nextId ?? 1, ...this.tasks.map((t) => t.id + 1));
    this.teamSeen = readJson<Record<string, string[]>>(this.file('team-seen.json'), {});
    const sessions = readJson<Record<string, string>>(this.file('sessions.json'), {});
    for (const [id, sessionId] of Object.entries(sessions)) this.runtime.set(id, newRuntime(sessionId));
    let lines: string[] = [];
    try { lines = fs.readFileSync(this.file('events.jsonl'), 'utf8').split('\n'); } catch {}
    // A line cut off by a crash must not take the rest of the history with it.
    let maxId = 0;
    const events: LogEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LogEvent;
        events.push(e);
        maxId = Math.max(maxId, e.id ?? 0);
      } catch {}
    }
    this.events = events.slice(-MAX_EVENTS_IN_MEMORY);
    this.nextEventId = maxId + 1;
  }

  private saveTasks() { writeJson(this.file('tasks.json'), { nextId: this.nextTaskId, tasks: this.tasks }); }
  private saveSessions() {
    const sessions: Record<string, string> = {};
    for (const [id, rt] of this.runtime) if (rt.sessionId) sessions[id] = rt.sessionId;
    writeJson(this.file('sessions.json'), sessions);
  }

  // ---------- views ----------

  agentViews(): AgentView[] {
    return this.agents.map((a) => {
      const { queue, abort, currentTasks, promptSent, ...rt } = this.rt(a.id);
      return { ...a, ...rt, queued: queue.length };
    });
  }

  status() {
    return { paused: this.paused, autoTurns: this.autoTurns, autoTurnBudget: this.autoTurnBudget };
  }

  isBusy() {
    return [...this.runtime.values()].some((rt) => rt.status === 'working' || rt.queue.length > 0);
  }

  private rt(id: string): Runtime {
    let rt = this.runtime.get(id);
    if (!rt) { rt = newRuntime(); this.runtime.set(id, rt); }
    return rt;
  }

  pushAgents() { this.emit('agents', this.agentViews()); }
  private pushTasks() { this.emit('tasks', this.tasks); }
  private pushStatus() { this.emit('status', this.status()); }

  log(e: Omit<LogEvent, 'id' | 'ts'>): LogEvent {
    const event: LogEvent = { id: this.nextEventId++, ts: new Date().toISOString(), ...e };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) this.events.splice(0, this.events.length - MAX_EVENTS_IN_MEMORY);
    // Synchronous, so lines land in order and a clear can't be overtaken by a pending write.
    try { fs.appendFileSync(this.file('events.jsonl'), JSON.stringify(event) + '\n'); } catch {}
    this.emit('event', event);
    return event;
  }

  clearLog() {
    this.events = [];
    fs.writeFileSync(this.file('events.jsonl'), '');
    this.emit('reset');
  }

  // ---------- team changes ----------

  /** A different CLI, account or folder cannot continue the old conversation. */
  onAgentChanged(before: AgentConfig, after: AgentConfig) {
    if (before.provider !== after.provider || before.account !== after.account || before.cwd !== after.cwd) {
      this.rt(after.id).sessionId = undefined;
      this.rt(after.id).promptSent = undefined;
      this.saveSessions();
    }
  }

  onAgentRemoved(id: string) {
    this.stopAgent(id);
    this.runtime.delete(id);
    this.saveSessions();
  }

  /** Starts a fresh conversation for the agent (forgets its context in this project). */
  resetSession(id: string) {
    this.rt(id).sessionId = undefined;
    this.rt(id).promptSent = undefined;
    this.saveSessions();
    this.log({ agentId: id, kind: 'system', text: 'Started a new conversation; previous context is forgotten.' });
    this.pushAgents();
  }

  private agent(id: string) { return this.agents.find((a) => a.id === id); }

  // ---------- messaging ----------

  async sendFromUser(to: string, text: string) {
    if (!this.agent(to)) throw new Error(`no agent "${to}"`);
    if (!text.trim()) throw new Error('empty message');
    const wasPaused = this.paused;
    this.autoTurns = 0;
    this.paused = false;
    this.pushStatus();
    this.log({ agentId: to, kind: 'user', from: 'user', text });
    // Snapshot the project before the team touches it, so this request can be undone.
    try {
      const cp = await createCheckpoint(this.project.path, `Before: ${text}`);
      if (cp) this.log({ agentId: 'system', kind: 'system', text: 'Checkpoint saved before this request.', meta: { checkpoint: cp.id } });
    } catch (e) {
      this.log({ agentId: 'system', kind: 'system', text: `Could not save a checkpoint: ${(e as Error).message}` });
    }
    this.enqueue(to, { kind: 'user', from: 'user', text });
    // A message from you resumes the team, so work that was held back by the pause starts too.
    if (wasPaused) for (const a of this.agents) this.schedule(a.id);
  }

  createTask(from: string, to: string, title: string, details: string): Task {
    const now = new Date().toISOString();
    const task: Task = { id: this.nextTaskId++, from, to, title: title || details.split('\n')[0].slice(0, 80), details, status: 'queued', result: '', createdAt: now, updatedAt: now };
    this.tasks.push(task);
    this.saveTasks();
    this.pushTasks();
    const text = `[Task #${task.id} from ${from}] ${task.title}\n\n${details}`.trim();
    this.log({ agentId: to, kind: 'inbox', from, taskId: task.id, text: details || task.title, meta: { title: task.title, type: 'task' } });
    this.enqueue(to, { kind: 'task', from, text, taskId: task.id });
    return task;
  }

  cancelTask(id: number) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.status === 'done') return;
    const rt = this.rt(task.to);
    rt.queue = rt.queue.filter((q) => q.taskId !== id);
    this.setTask(task, 'cancelled');
    // The agent is working on it right now: stop that turn instead of letting it finish unseen.
    if (rt.currentTasks.includes(id)) rt.abort?.abort();
    this.pushAgents();
  }

  private setTask(task: Task, status: TaskStatus, result?: string) {
    task.status = status;
    if (result !== undefined) task.result = result;
    task.updatedAt = new Date().toISOString();
    this.saveTasks();
    this.pushTasks();
  }

  private enqueue(id: string, item: InboxItem) {
    this.rt(id).queue.push(item);
    this.pushAgents();
    this.schedule(id);
  }

  private schedule(id: string) {
    const rt = this.rt(id);
    if (rt.status === 'working' || rt.queue.length === 0 || this.paused) return;
    void this.runTurn(id);
  }

  // ---------- turns ----------

  private takeBatch(rt: Runtime): InboxItem[] {
    // One task per turn, so each reply maps to exactly one task result.
    // Everything else (user messages, results, notes) is batched: fewer turns, fewer tokens.
    const batch: InboxItem[] = [];
    let tookTask = false;
    rt.queue = rt.queue.filter((item) => {
      if (item.kind === 'task') {
        if (tookTask) return true;
        tookTask = true;
      }
      batch.push(item);
      return false;
    });
    return batch;
  }

  private async runTurn(id: string) {
    const config = this.agent(id);
    if (!config) return;
    // Agents work in the project folder unless they have their own folder set.
    const agent: AgentConfig = { ...config, cwd: config.cwd || this.project.path };
    const rt = this.rt(id);
    const batch = this.takeBatch(rt);
    if (!batch.length) return;

    if (batch.every((b) => b.kind !== 'user')) {
      if (this.autoTurns >= this.autoTurnBudget) {
        rt.queue.unshift(...batch);
        this.paused = true;
        this.log({ agentId: 'system', kind: 'system', text: `Paused after ${this.autoTurns} automatic turns without a message from you. Press Resume to continue.` });
        this.pushStatus();
        this.pushAgents();
        return;
      }
      this.autoTurns++;
      this.pushStatus();
    }

    const adapter = ADAPTERS[agent.provider];
    const sysPrompt = systemPrompt(agent, this.agents, this.project);
    let prompt = batch.map((b) => (b.kind === 'user' ? `[From user]\n${b.text}` : b.text)).join('\n\n---\n\n');
    if (!adapter.systemPromptFlag) {
      // CLIs without a system prompt flag get it inside the message: at the start of a conversation,
      // and again whenever it changed (new role or instructions, team members added or removed).
      if (!rt.sessionId) prompt = `${sysPrompt}\n\n=====\n\n${prompt}`;
      else if (rt.promptSent !== sysPrompt) prompt = `[Updated instructions from the orchestrator; they replace the earlier ones]\n${sysPrompt}\n\n=====\n\n${prompt}`;
    }
    const team = this.teamUpdate(agent, !!rt.sessionId);
    if (team.note) prompt = `${team.note}\n\n---\n\n${prompt}`;

    const taskIds = batch.filter((b) => b.kind === 'task').map((b) => b.taskId!);
    for (const tid of taskIds) {
      const t = this.tasks.find((x) => x.id === tid);
      if (t) this.setTask(t, 'working');
    }

    rt.status = 'working';
    rt.lastError = undefined;
    rt.abort = new AbortController();
    rt.currentTasks = taskIds;
    this.pushAgents();

    let result: TurnResult;
    try {
      // Never fall back to another folder: an agent with write access must not work somewhere unexpected.
      if (!fs.existsSync(agent.cwd) || !fs.statSync(agent.cwd).isDirectory()) throw new Error(`folder not found: ${agent.cwd}`);
      result = await adapter.runTurn({
        agent,
        prompt,
        systemPrompt: adapter.systemPromptFlag ? sysPrompt : '',
        sessionId: rt.sessionId,
        signal: rt.abort.signal,
        emit: (e) => this.log({ ...e, agentId: id }),
      });
    } catch (err) {
      result = { ok: false, finalText: '', error: err instanceof Error ? err.message : String(err) };
    }
    const aborted = rt.abort?.signal.aborted;
    rt.abort = undefined;
    rt.currentTasks = [];
    if (!adapter.systemPromptFlag && result.ok) rt.promptSent = sysPrompt;
    if (result.ok) team.commit();
    rt.turns++;
    if (result.sessionId) { rt.sessionId = result.sessionId; this.saveSessions(); }
    rt.costUsd += result.costUsd ?? 0;
    rt.tokens += result.tokens ?? 0;

    if (aborted) {
      rt.status = 'stopped';
      this.log({ agentId: id, kind: 'system', text: 'Stopped.' });
      for (const tid of taskIds) {
        const t = this.tasks.find((x) => x.id === tid);
        if (t && t.status !== 'cancelled') this.setTask(t, 'cancelled');
      }
      this.pushAgents();
      // Messages that arrived while the process was shutting down still need a turn.
      this.schedule(id);
      return;
    }

    if (!result.ok) {
      rt.status = 'error';
      rt.lastError = result.error;
      this.log({ agentId: id, kind: 'error', text: result.error || 'unknown error' });
    } else {
      rt.status = 'idle';
    }
    this.log({ agentId: id, kind: 'turn_end', text: '', meta: { costUsd: result.costUsd, tokens: result.tokens, ok: result.ok } });

    const text = result.finalText || '';
    // Tags may appear in any text block of the turn, not only in the final one.
    const allText = result.allText || text;
    if (result.ok) this.applyDirectives(agent, allText);

    for (const tid of taskIds) {
      const task = this.tasks.find((t) => t.id === tid);
      if (!task || task.status === 'cancelled') continue;
      const blocked = result.ok ? parseBlocked(allText) : result.error || 'agent failed';
      const summary = stripDirectives(text) || (blocked ?? '(no reply)');
      this.setTask(task, blocked ? 'blocked' : 'done', blocked ? `${blocked}${summary !== blocked ? `\n\n${summary}` : ''}` : summary);
      if (this.agent(task.from)) {
        const header = `[Result of task #${task.id} from ${id}] ${blocked ? 'BLOCKED' : 'done'} — ${task.title}`;
        this.log({ agentId: task.from, kind: 'inbox', from: id, taskId: task.id, text: task.result, meta: { title: task.title, type: 'result', status: task.status } });
        this.enqueue(task.from, { kind: 'result', from: id, taskId: task.id, text: `${header}\n\n${task.result}` });
      }
    }

    this.pushAgents();
    this.schedule(id);
  }

  /**
   * A note for a delegating agent about team members added or removed since it last heard,
   * so it stops sending work to agents that are gone and starts using new ones. Its conversation
   * history still mentions the old team, so a changed system prompt alone is not enough.
   * commit() records the team as seen once the turn went through.
   */
  private teamUpdate(agent: AgentConfig, hasSession: boolean): { note: string | null; commit: () => void } {
    const current = this.agents.filter((a) => a.id !== agent.id);
    const ids = current.map((a) => a.id);
    const commit = () => {
      this.teamSeen[agent.id] = ids;
      writeJson(this.file('team-seen.json'), this.teamSeen);
    };
    // A new conversation starts with the full roster in the system prompt.
    if (!CAN_DELEGATE.includes(agent.role) || !hasSession) return { note: null, commit };
    const seen = this.teamSeen[agent.id];
    const roster = current.map(describeAgent).join('\n');
    if (!seen) return { note: `[Team update from the orchestrator] The team is now:\n${roster}`, commit };
    const added = current.filter((a) => !seen.includes(a.id));
    const removed = seen.filter((id) => !ids.includes(id));
    if (!added.length && !removed.length) return { note: null, commit };
    const lines = ['[Team update from the orchestrator]'];
    if (added.length) lines.push(`Joined the team (give them work too):\n${added.map(describeAgent).join('\n')}`);
    if (removed.length) lines.push(`Left the team (do not send them anything): ${removed.join(', ')}`);
    lines.push(`The team is now:\n${roster}`);
    return { note: lines.join('\n'), commit };
  }

  /** Tells the agent that a task or message of its own went nowhere, so it can send it elsewhere. */
  private bounce(agent: AgentConfig, text: string) {
    this.log({ agentId: agent.id, kind: 'system', text });
    const others = this.agents.filter((a) => a.id !== agent.id).map(describeAgent).join('\n');
    this.enqueue(agent.id, { kind: 'message', from: 'system', text: `[From the orchestrator] ${text}\nThe team is:\n${others}` });
  }

  private applyDirectives(agent: AgentConfig, text: string) {
    for (const d of parseDirectives(text)) {
      if (!this.agent(d.to) || d.to === agent.id) {
        this.bounce(agent, d.to === agent.id
          ? `Your ${d.type} to yourself ("${d.to}") was not delivered; give it to another agent.`
          : `Your ${d.type} for "${d.to}" was not delivered: there is no agent with that id.${d.title ? ` (Task: ${d.title})` : ''} Send it to an agent from the team below.`);
        continue;
      }
      if (d.type === 'task') {
        if (!CAN_DELEGATE.includes(agent.role)) {
          this.bounce(agent, `Your task for ${d.to} was not delivered: only a Lead (or Custom role) can delegate. Send a <message> instead or do it yourself.`);
          continue;
        }
        this.createTask(agent.id, d.to, d.title || '', d.body);
      } else {
        this.log({ agentId: d.to, kind: 'inbox', from: agent.id, text: d.body, meta: { type: 'message' } });
        this.enqueue(d.to, { kind: 'message', from: agent.id, text: `[Message from ${agent.id}]\n${d.body}` });
      }
    }
  }

  // ---------- control ----------

  stopAgent(id: string) {
    const rt = this.runtime.get(id);
    if (!rt) return;
    for (const item of rt.queue) {
      const t = item.taskId ? this.tasks.find((x) => x.id === item.taskId) : undefined;
      if (t) this.setTask(t, 'cancelled');
    }
    rt.queue = [];
    if (rt.abort) rt.abort.abort();
    else if (rt.status !== 'working') rt.status = 'idle';
    this.pushAgents();
  }

  stopAll() {
    const busy = this.isBusy();
    for (const a of this.agents) this.stopAgent(a.id);
    if (busy) this.log({ agentId: 'system', kind: 'system', text: 'Stopped all agents and cleared their queues.' });
  }

  resume() {
    this.paused = false;
    this.autoTurns = 0;
    this.pushStatus();
    for (const a of this.agents) this.schedule(a.id);
  }
}

function newRuntime(sessionId?: string): Runtime {
  return { status: 'idle', queued: 0, queue: [], currentTasks: [], sessionId, turns: 0, costUsd: 0, tokens: 0 };
}
