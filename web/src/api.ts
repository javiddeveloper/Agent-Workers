import { useEffect, useRef, useState } from 'react';
import type { AgentView, Checkpoint, LogEvent, Project, Task } from '../../server/types.ts';

export type { AgentView, Checkpoint, LogEvent, Project, Task };
export type { AgentConfig, PermissionLevel, ProviderId, RoleId } from '../../server/types.ts';

declare global {
  interface Window { AGENT_WORKERS_TOKEN: string }
}

export const TOKEN = window.AGENT_WORKERS_TOKEN;

export interface ProviderInfo { id: string; label: string; models: string[] }
export interface RoleInfo { id: string; label: string; prompt: string }
export interface EditorInfo { id: string; label: string }
export interface Status { paused: boolean; autoTurns: number; autoTurnBudget: number }
export interface ProjectView extends Project { git: boolean; exists: boolean }

export interface AppState {
  connected: boolean;
  projects: Project[];
  project: ProjectView | null;
  agents: AgentView[];
  tasks: Task[];
  events: LogEvent[];
  status: Status;
  providers: ProviderInfo[];
  roles: RoleInfo[];
  editors: EditorInfo[];
  home: string;
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

let currentProject: string | null = null;

/** API call scoped to the open project. */
export function papi<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  if (!currentProject) return Promise.reject(new Error('Open a project first'));
  return api<T>(method, `/p/${currentProject}${url}`, body);
}

type Listener = (msg: any) => void;
let socket: WebSocket | null = null;
const listeners = new Set<Listener>();

export function wsSend(msg: unknown) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(msg));
}

export function onWs(fn: Listener) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function savedProject() {
  try { return localStorage.getItem('aw-project'); } catch { return null; }
}

/** Switches the console to another project (the server streams that project's activity). */
export function openProject(id: string) {
  try { localStorage.setItem('aw-project', id); } catch {}
  currentProject = id;
  wsSend({ t: 'subscribe', project: id });
  void api('POST', `/projects/${id}/activate`).catch(() => {});
}

const initial: AppState = {
  connected: false,
  projects: [],
  project: null,
  agents: [],
  tasks: [],
  events: [],
  status: { paused: false, autoTurns: 0, autoTurnBudget: 60 },
  providers: [],
  roles: [],
  editors: [],
  home: '',
};

/** Live application state, kept in sync over the WebSocket. */
export function useAppState(): AppState {
  const [state, setState] = useState<AppState>(initial);
  const retry = useRef<number>();

  useEffect(() => {
    let closed = false;
    const connect = () => {
      const ws = new WebSocket(`ws://${location.host}/ws?token=${TOKEN}`);
      socket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: 'subscribe', project: currentProject ?? savedProject() }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        for (const l of listeners) l(msg);
        if (msg.t === 'snapshot') currentProject = msg.project?.id ?? null;
        setState((s) => {
          switch (msg.t) {
            case 'snapshot': {
              const { t, active, ...rest } = msg;
              return { ...s, ...rest, connected: true };
            }
            case 'event': return { ...s, events: [...s.events, msg.event].slice(-3000) };
            case 'agents': return { ...s, agents: msg.agents };
            case 'tasks': return { ...s, tasks: msg.tasks };
            case 'status': return { ...s, status: msg.status };
            case 'projects': {
              // The open project was removed: fall back to the server's active one.
              if (s.project && !msg.projects.some((p: Project) => p.id === s.project!.id)) {
                currentProject = null;
                ws.send(JSON.stringify({ t: 'subscribe', project: msg.active }));
              }
              return { ...s, projects: msg.projects };
            }
            default: return s;
          }
        });
      };
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!closed) retry.current = window.setTimeout(connect, 1000);
      };
    };
    connect();
    return () => { closed = true; clearTimeout(retry.current); socket?.close(); };
  }, []);

  return state;
}
