// Role prompts and the text protocol agents use to talk to the orchestrator.
// The protocol is plain text tags, so it works with any CLI, with or without tool use.
import type { AgentConfig, Project, RoleId } from './types.ts';
import { ADAPTERS } from './adapters.ts';

export const ROLE_LABELS: Record<RoleId, string> = {
  lead: 'Lead',
  worker: 'Worker',
  reviewer: 'Reviewer',
  custom: 'Custom',
};

export const ROLE_PROMPTS: Record<RoleId, string> = {
  lead:
    'You are the LEAD of the team. You talk to the user, plan the work and delegate it. ' +
    'Prefer delegating implementation to workers instead of doing it yourself. ' +
    'Split work into small, independent tasks with precise instructions (files, acceptance criteria). ' +
    'Use the whole team: spread independent tasks across all workers so they run in parallel, prefer a worker that has nothing to do, ' +
    'and play to each model\'s strengths. Only keep tasks on one agent when they edit the same files and would conflict; otherwise hand them to different workers. ' +
    'When results come back, check them, delegate follow-ups or fixes, and when everything is finished give the user a short final report in the user\'s language.',
  worker:
    'You are a WORKER. You receive tasks and carry them out completely in the working directory: implement, then verify (build, run, test). ' +
    'Stay strictly within the scope of the task; other agents may be editing other files at the same time.',
  reviewer:
    'You are a REVIEWER. For each task, review the referenced work for bugs, regressions and risky changes. ' +
    'Report concrete findings with file paths; do not rewrite code unless the task asks you to.',
  custom: '',
};

// Agents can't ask for approval mid-turn, so tell them up front what they may do; it saves wasted attempts.
const PERMISSION_NOTE: Record<AgentConfig['permission'], string> = {
  readonly: 'Your permissions: read-only. You can read and search files, but you cannot edit files or run shell commands, so do not try. Delegate anything that needs them.',
  edit: 'Your permissions: you can read and edit files, but you cannot run shell commands (no builds or tests), so do not try.',
  auto: 'Your permissions: you can read and edit files and run commands; clearly destructive commands may be refused.',
  full: 'Your permissions: full access to files and commands.',
};

/** One roster line, e.g. "- worker-1: Worker (Antigravity)". */
export function describeAgent(a: AgentConfig): string {
  const model = a.model ? `, ${a.model}` : '';
  return `- ${a.id}: ${ROLE_LABELS[a.role]} (${ADAPTERS[a.provider].label}${model})`;
}

function roster(self: AgentConfig, team: AgentConfig[]): string {
  return team.map((a) => describeAgent(a) + (a.id === self.id ? '  ← you' : '')).join('\n');
}

export function systemPrompt(self: AgentConfig, team: AgentConfig[], project: Project): string {
  const canDelegate = self.role === 'lead' || self.role === 'custom';
  const lines = [
    `You are "${self.name}" (agent id: ${self.id}) in a team of AI agents run by an orchestrator.`,
    `The team is working on the project "${project.name}" in ${project.path}. Your working directory: ${self.cwd || project.path}.`,
    '',
    ROLE_PROMPTS[self.role],
    self.instructions?.trim() ? `\nAdditional instructions:\n${self.instructions.trim()}` : '',
    '',
    PERMISSION_NOTE[self.permission],
    '',
    'Team:',
    roster(self, team),
    '',
    'Protocol (the orchestrator reads these tags from your reply):',
  ];
  if (canDelegate) {
    lines.push(
      '- Delegate work with one block per task:',
      '  <task to="AGENT_ID" title="short title">complete, self-contained instructions</task>',
      '  The agent sees only what you write in the block. You may assign several tasks in one reply; they run in parallel.',
      '  Each result comes back to you automatically as a message "[Result of task #N from AGENT_ID]". Do not wait or poll; just end your reply.',
    );
  }
  lines.push(
    '- Send a short note to another agent: <message to="AGENT_ID">text</message>',
    '- When you are handling a task, your final reply IS the task result: summarize what you did, which files changed and how you verified it, in a few lines.',
    '- If you cannot complete a task, include <blocked>reason</blocked> in your reply.',
    'Messages to you arrive as "[From user]", "[Task #N from AGENT_ID]", "[Result of task #N from AGENT_ID]" or "[Message from AGENT_ID]".',
  );
  return lines.filter((l) => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface Directive {
  type: 'task' | 'message';
  to: string;
  title?: string;
  body: string;
}

const TAG_RE = /<(task|message)\s+([^>]*)>([\s\S]*?)<\/\1>/gi;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g;

export function parseDirectives(text: string): Directive[] {
  const out: Directive[] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(ATTR_RE)) attrs[(a[1] ?? a[3]).toLowerCase()] = a[2] ?? a[4];
    if (!attrs.to) continue;
    out.push({ type: m[1].toLowerCase() as Directive['type'], to: attrs.to.trim(), title: attrs.title?.trim(), body: m[3].trim() });
  }
  return out;
}

export function parseBlocked(text: string): string | null {
  const m = text.match(/<blocked>([\s\S]*?)<\/blocked>/i);
  return m ? m[1].trim() || 'blocked' : null;
}

/** The reply without protocol tags, for task results and summaries. */
export function stripDirectives(text: string): string {
  return text.replace(TAG_RE, '').replace(/<\/?blocked>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}
