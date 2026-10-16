// Global stores: the team of agents (shared by every project) and the list of projects.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig, Project, RoleId } from './types.ts';

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

export const expandHome = (p: string) => p.trim().replace(/^~(?=$|\/)/, os.homedir());

function slugify(name: string, taken: (id: string) => boolean, fallback: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
  let id = base;
  for (let i = 2; taken(id); i++) id = `${base}-${i}`;
  return id;
}

// ---------- agents ----------

const PALETTE = ['#d97757', '#61afef', '#4ec98a', '#c678dd', '#e5c07b', '#56b6c2', '#e06c75', '#98c379'];

/** Emits "changed" (before, after) when an agent's config changes, "list" when the team changes. */
export class AgentStore extends EventEmitter {
  list: AgentConfig[];

  constructor(private file: string) {
    super();
    this.list = readJson<any[]>(file, []).map((a, i) => normalizeAgent(migrateAgent(a), i));
    this.save();
  }

  private save() { writeJson(this.file, this.list); }

  get(id: string) { return this.list.find((a) => a.id === id); }

  add(input: Partial<AgentConfig>): AgentConfig {
    if (!input.name?.trim()) throw new Error('name is required');
    const id = slugify(input.name, (x) => this.list.some((a) => a.id === x), 'agent');
    // Each new agent gets its own login unless an account is chosen explicitly.
    const agent = normalizeAgent({ ...input, id, account: input.account?.trim() || id }, this.list.length);
    this.list.push(agent);
    this.save();
    this.emit('list');
    return agent;
  }

  update(id: string, input: Partial<AgentConfig>): AgentConfig {
    const i = this.list.findIndex((a) => a.id === id);
    if (i < 0) throw new Error(`no agent "${id}"`);
    const before = this.list[i];
    const after = normalizeAgent({ ...before, ...input, id }, i);
    this.list[i] = after;
    this.save();
    this.emit('changed', before, after);
    this.emit('list');
    return after;
  }

  remove(id: string) {
    this.list = this.list.filter((a) => a.id !== id);
    this.save();
    this.emit('removed', id);
    this.emit('list');
  }
}

function normalizeAgent(a: Partial<AgentConfig> & { id: string }, index: number): AgentConfig {
  return {
    id: a.id,
    name: (a.name || a.id).trim(),
    provider: a.provider ?? 'claude',
    account: (a.account || 'default').trim(),
    model: (a.model || '').trim(),
    role: a.role ?? 'worker',
    instructions: a.instructions ?? '',
    cwd: a.cwd ? expandHome(a.cwd) : '',
    permission: a.permission ?? 'auto',
    sandbox: !!a.sandbox,
    command: a.command?.trim() || undefined,
    color: a.color || PALETTE[index % PALETTE.length],
  };
}

/** Accepts agents saved by the first (terminal-based) version too. */
function migrateAgent(a: any): Partial<AgentConfig> & { id: string } {
  if (a.provider) return a;
  const roleMap: Record<string, RoleId> = { orchestrator: 'lead', coder: 'worker', reviewer: 'reviewer' };
  return {
    ...a,
    provider: a.cli === 'gemini' ? 'gemini' : a.cli === 'custom' ? 'custom' : 'claude',
    role: roleMap[a.role] ?? 'custom',
    permission: a.autoApprove ? 'full' : 'auto',
    instructions: '',
  };
}

// ---------- projects ----------

interface ProjectsFile { active?: string; projects: Project[] }

export class ProjectStore extends EventEmitter {
  private data: ProjectsFile;

  constructor(private file: string) {
    super();
    this.data = readJson<ProjectsFile>(file, { projects: [] });
  }

  get list() { return this.data.projects; }
  get active() { return this.data.active && this.get(this.data.active) ? this.data.active : this.list[0]?.id; }
  get(id: string) { return this.list.find((p) => p.id === id); }

  private save() {
    writeJson(this.file, this.data);
    this.emit('list');
  }

  /** Registers a folder as a project (the folder must exist). Re-adding a known folder returns it. */
  add(name: string, folder: string): Project {
    const resolved = path.resolve(expandHome(folder));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`folder not found: ${resolved}`);
    const existing = this.list.find((p) => p.path === resolved);
    if (existing) return existing;
    const project: Project = {
      id: slugify(name || path.basename(resolved), (x) => this.list.some((p) => p.id === x), 'project'),
      name: (name || path.basename(resolved)).trim(),
      path: resolved,
      createdAt: new Date().toISOString(),
    };
    this.data.projects.push(project);
    this.save();
    return project;
  }

  rename(id: string, name: string) {
    const p = this.get(id);
    if (!p) throw new Error('no such project');
    p.name = name.trim() || p.name;
    this.save();
    return p;
  }

  /** Forgets the project (its folder is not touched). */
  remove(id: string) {
    this.data.projects = this.list.filter((p) => p.id !== id);
    if (this.data.active === id) this.data.active = undefined;
    this.save();
  }

  setActive(id: string) {
    if (!this.get(id)) throw new Error('no such project');
    this.data.active = id;
    this.save();
  }
}
