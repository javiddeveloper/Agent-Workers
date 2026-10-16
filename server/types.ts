// Shared types between the orchestrator, the provider adapters and the web UI.

export type ProviderId = 'claude' | 'gemini' | 'antigravity' | 'custom';
export type RoleId = 'lead' | 'worker' | 'reviewer' | 'custom';
/** How much an agent may do without asking. Headless agents cannot ask, so anything not allowed is refused. */
export type PermissionLevel = 'readonly' | 'edit' | 'auto' | 'full';

export interface AgentConfig {
  id: string;
  name: string;
  provider: ProviderId;
  /** "default" = the user's normal login; any other name gets an isolated login. */
  account: string;
  model: string;
  role: RoleId;
  /** Extra instructions on top of the role prompt. */
  instructions: string;
  /** Optional override; empty = the project's folder. */
  cwd: string;
  permission: PermissionLevel;
  sandbox: boolean;
  /** Only for provider "custom": command line; {prompt} is replaced by the message. */
  command?: string;
  color?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface Checkpoint {
  id: string; // commit sha
  ts: string;
  label: string;
}

export type AgentStatus ='idle' | 'working' | 'error' | 'stopped';

export interface AgentRuntime {
  status: AgentStatus;
  queued: number;
  sessionId?: string;
  lastError?: string;
  turns: number;
  costUsd: number;
  tokens: number;
}

export type AgentView = AgentConfig & AgentRuntime;

export type TaskStatus = 'queued' | 'working' | 'done' | 'blocked' | 'cancelled';

export interface Task {
  id: number;
  from: string; // agent id or "user"
  to: string;
  title: string;
  details: string;
  status: TaskStatus;
  result: string;
  createdAt: string;
  updatedAt: string;
}

export type EventKind =
  | 'user' // a message the human sent
  | 'inbox' // a message delivered to an agent (task, result, direct message)
  | 'text' // agent's visible reply text
  | 'thinking'
  | 'tool' // agent invoked a tool
  | 'tool_result'
  | 'turn_end'
  | 'system'
  | 'error';

export interface LogEvent {
  id: number;
  ts: string;
  agentId: string; // agent the event belongs to ("system" for orchestrator notices)
  kind: EventKind;
  text: string;
  /** For inbox: who sent it. For tool: tool name. */
  from?: string;
  taskId?: number;
  meta?: Record<string, unknown>;
}

/** What an adapter reports while a turn runs. */
export type TurnEmit = (e: Omit<LogEvent, 'id' | 'ts' | 'agentId'>) => void;

export interface TurnResult {
  sessionId?: string;
  finalText: string;
  /** Every text block of the turn, for reading protocol tags (finalText is only the last reply). */
  allText?: string;
  costUsd?: number;
  tokens?: number;
  ok: boolean;
  error?: string;
}
