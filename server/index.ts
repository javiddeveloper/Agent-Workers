// HTTP + WebSocket server for the Agent Workers console.
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import pty from 'node-pty';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS_DIR, ADAPTERS, agentEnv, killAllProcesses } from './adapters.ts';
import { createCheckpoint, initRepo, isGitRepo, listCheckpoints, restoreCheckpoint } from './checkpoints.ts';
import { Orchestrator } from './orchestrator.ts';
import { ROLE_LABELS, ROLE_PROMPTS } from './prompts.ts';
import { AgentStore, ProjectStore, expandHome } from './store.ts';
import { hostGuard, isAllowedHost } from './security.ts';
import type { AgentConfig } from './types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
// AGENT_WORKERS_DATA keeps the team, projects and logs somewhere else (e.g. a demo or a second console).
const DATA = process.env.AGENT_WORKERS_DATA ? path.resolve(process.env.AGENT_WORKERS_DATA) : path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 4777);
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(16).toString('hex');

const team = new AgentStore(path.join(DATA, 'agents.json'));
const projects = new ProjectStore(path.join(DATA, 'projects.json'));
migrateSingleProjectData();

// ---------- orchestrators (one per project, created on demand) ----------

const orchestrators = new Map<string, Orchestrator>();

function orch(projectId: string): Orchestrator {
  const project = projects.get(projectId);
  if (!project) throw new Error(`no project "${projectId}"`);
  let o = orchestrators.get(projectId);
  if (!o) {
    o = new Orchestrator(project, team, path.join(DATA, 'projects', projectId));
    o.on('event', (event) => toProject(projectId, { t: 'event', event }));
    o.on('agents', (agents) => toProject(projectId, { t: 'agents', agents }));
    o.on('tasks', (tasks) => toProject(projectId, { t: 'tasks', tasks }));
    o.on('status', (status) => toProject(projectId, { t: 'status', status }));
    o.on('reset', () => void sendSnapshotToProject(projectId));
    orchestrators.set(projectId, o);
  }
  return o;
}

team.on('changed', (before: AgentConfig, after: AgentConfig) => { for (const o of orchestrators.values()) o.onAgentChanged(before, after); });
team.on('removed', (id: string) => { for (const o of orchestrators.values()) o.onAgentRemoved(id); });
team.on('list', () => {
  for (const o of orchestrators.values()) o.pushAgents();
  toUnsubscribed({ t: 'agents', agents: team.list });
});
projects.on('list', () => toAll({ t: 'projects', projects: projects.list, active: projects.active }));

// ---------- editors ----------

const EDITORS = [
  { id: 'cursor', label: 'Cursor', app: 'Cursor' },
  { id: 'vscode', label: 'VS Code', app: 'Visual Studio Code' },
  { id: 'antigravity', label: 'Antigravity', app: 'Antigravity IDE' },
  { id: 'zed', label: 'Zed', app: 'Zed' },
  { id: 'xcode', label: 'Xcode', app: 'Xcode' },
].filter((e) => ['/Applications', path.join(os.homedir(), 'Applications')].some((d) => fs.existsSync(path.join(d, `${e.app}.app`))));

function openIn(target: string, dir: string) {
  const editor = EDITORS.find((e) => e.id === target);
  const args = target === 'finder' ? [dir] : target === 'terminal' ? ['-a', 'Terminal', dir] : editor ? ['-a', editor.app, dir] : null;
  if (!args) throw new Error('unknown app');
  execFile('open', args);
}

// ---------- snapshot ----------

async function snapshot(projectId?: string) {
  const id = projectId && projects.get(projectId) ? projectId : projects.active;
  const base = {
    projects: projects.list,
    active: projects.active,
    providers: Object.values(ADAPTERS).map((a) => ({ id: a.id, label: a.label, models: a.models })),
    roles: Object.entries(ROLE_LABELS).map(([rid, label]) => ({ id: rid, label, prompt: ROLE_PROMPTS[rid as keyof typeof ROLE_PROMPTS] })),
    editors: EDITORS.map(({ id: eid, label }) => ({ id: eid, label })),
    home: os.homedir(),
  };
  if (!id) return { ...base, project: null, agents: team.list, tasks: [], events: [], status: { paused: false, autoTurns: 0, autoTurnBudget: 60 } };
  const o = orch(id);
  return {
    ...base,
    project: { ...o.project, git: await isGitRepo(o.project.path).catch(() => false), exists: fs.existsSync(o.project.path) },
    agents: o.agentViews(),
    tasks: o.tasks,
    events: o.events.slice(-1500),
    status: o.status(),
  };
}

// ---------- HTTP ----------

const app = express();
app.use(hostGuard(PORT));
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => {
  const file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) return res.status(500).send('UI not built. Run: npm run build');
  res.type('html').send(fs.readFileSync(file, 'utf8').replace('__TOKEN__', TOKEN));
});
app.use(express.static(DIST, { index: false }));

app.use('/api', (req, res, next) => {
  if (req.get('x-token') !== TOKEN) return res.status(401).json({ error: 'bad token' });
  next();
});

type Handler = (req: express.Request) => unknown;
const wrap = (fn: Handler) => async (req: express.Request, res: express.Response) => {
  try { res.json((await fn(req)) ?? { ok: true }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
};
const P = (req: express.Request) => orch(req.params.pid);

app.get('/api/state', wrap((req) => snapshot(String(req.query.project || ''))));
app.get('/api/folders', wrap((req) => listFolders(String(req.query.path || os.homedir()))));
app.get('/api/folder-info', wrap((req) => folderInfo(String(req.query.path || ''))));

// Team
app.post('/api/agents', wrap((req) => team.add(req.body)));
app.put('/api/agents/:id', wrap((req) => team.update(req.params.id, req.body)));
app.delete('/api/agents/:id', wrap((req) => team.remove(req.params.id)));

// Projects
app.post('/api/projects', wrap(async (req) => {
  const { name = '', folder = '', create = false } = req.body as { name?: string; folder?: string; create?: boolean };
  let dir = path.resolve(expandHome(folder || path.join(os.homedir(), 'Documents', 'Projects')));
  if (create) {
    if (!name.trim()) throw new Error('project name is required');
    dir = path.join(dir, name.trim().replace(/[/\\:]/g, '-'));
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`folder already exists and is not empty: ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
    await initRepo(dir);
  }
  const project = projects.add(name, dir);
  projects.setActive(project.id);
  return project;
}));
app.put('/api/projects/:pid', wrap((req) => projects.rename(req.params.pid, String(req.body.name ?? ''))));
app.delete('/api/projects/:pid', wrap((req) => {
  orchestrators.get(req.params.pid)?.stopAll();
  orchestrators.delete(req.params.pid);
  projects.remove(req.params.pid);
}));
app.post('/api/projects/:pid/activate', wrap((req) => projects.setActive(req.params.pid)));
app.post('/api/projects/:pid/open', wrap((req) => openIn(String(req.body.app), P(req).project.path)));
app.post('/api/projects/:pid/git-init', wrap(async (req) => {
  const dir = P(req).project.path;
  if (!(await isGitRepo(dir))) await initRepo(dir);
  await createCheckpoint(dir, 'Checkpoints enabled');
  await sendSnapshotToProject(req.params.pid);
}));
app.get('/api/projects/:pid/checkpoints', wrap((req) => listCheckpoints(P(req).project.path)));
app.post('/api/projects/:pid/checkpoints/:sha/restore', wrap(async (req) => {
  const o = P(req);
  if (o.isBusy()) throw new Error('Stop the agents before restoring a checkpoint.');
  await restoreCheckpoint(o.project.path, req.params.sha);
  o.log({ agentId: 'system', kind: 'system', text: `Restored the project files to checkpoint ${req.params.sha.slice(0, 8)}. Agents still remember the conversation; tell the lead what changed if needed.` });
}));

// Work inside a project
app.post('/api/p/:pid/send', wrap((req) => P(req).sendFromUser(req.body.to, String(req.body.text ?? ''))));
app.post('/api/p/:pid/agents/:id/stop', wrap((req) => P(req).stopAgent(req.params.id)));
app.post('/api/p/:pid/agents/:id/reset', wrap((req) => P(req).resetSession(req.params.id)));
app.post('/api/p/:pid/tasks/:id/cancel', wrap((req) => P(req).cancelTask(Number(req.params.id))));
app.post('/api/p/:pid/stop-all', wrap((req) => P(req).stopAll()));
app.post('/api/p/:pid/resume', wrap((req) => P(req).resume()));
app.delete('/api/p/:pid/events', wrap((req) => P(req).clearLog()));

const PROJECT_MARKERS = ['.git', 'package.json', 'build.gradle', 'build.gradle.kts', 'settings.gradle.kts', 'pom.xml', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Package.swift', 'pubspec.yaml', 'composer.json', 'Gemfile'];

/** Lets the UI warn before creating a new project inside what is already a project. */
function folderInfo(dir: string) {
  const resolved = path.resolve(expandHome(dir || os.homedir()));
  const exists = fs.existsSync(resolved);
  const markers = exists ? PROJECT_MARKERS.filter((m) => fs.existsSync(path.join(resolved, m))) : [];
  return { path: resolved, exists, isProject: markers.length > 0, markers };
}

function listFolders(dir: string) {
  const resolved = path.resolve(expandHome(dir));
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return { path: resolved, parent: path.dirname(resolved), folders: entries };
}

// ---------- WebSocket ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const subscription = new WeakMap<WebSocket, string>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const origin = req.headers.origin ?? '';
  const okOrigin = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`].includes(origin);
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== TOKEN || !okOrigin || !isAllowedHost(req.headers.host, PORT)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function toAll(msg: unknown) { for (const c of wss.clients) send(c, msg); }
function toProject(projectId: string, msg: unknown) {
  for (const c of wss.clients) if (subscription.get(c) === projectId) send(c, msg);
}
function toUnsubscribed(msg: unknown) {
  for (const c of wss.clients) if (!subscription.get(c)) send(c, msg);
}
async function sendSnapshotToProject(projectId: string) {
  const snap = await snapshot(projectId);
  toProject(projectId, { t: 'snapshot', ...snap });
}

// Sign-in terminals: the only place a raw terminal is shown, to log a CLI into an account.
const logins = new Map<WebSocket, pty.IPty>();

/**
 * node-pty starts terminals through a small "spawn-helper" binary that npm may unpack without the
 * execute bit (then every terminal fails with "posix_spawnp failed"). Fix it here instead of
 * relying on an install script having run.
 */
function ensurePtyHelper() {
  try {
    const dir = path.join(path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds');
    for (const platform of fs.readdirSync(dir)) {
      const helper = path.join(dir, platform, 'spawn-helper');
      if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755);
    }
  } catch (e) {
    console.error('[node-pty] could not check spawn-helper:', (e as Error).message);
  }
}
ensurePtyHelper();

wss.on('connection', (ws) => {
  ws.on('message', (raw) => handleWsMessage(ws, raw).catch((e) => send(ws, { t: 'error', error: String(e?.message ?? e) })));
  ws.on('close', () => { logins.get(ws)?.kill(); logins.delete(ws); });
});

async function handleWsMessage(ws: WebSocket, raw: unknown) {
  {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.t === 'subscribe') {
      const id = projects.get(msg.project) ? msg.project : projects.active;
      if (id) subscription.set(ws, id); else subscription.delete(ws);
      send(ws, { t: 'snapshot', ...(await snapshot(id)) });
    } else if (msg.t === 'login-start') {
      logins.get(ws)?.kill();
      const agent = team.get(msg.agentId);
      if (!agent) return;
      const cmd = ADAPTERS[agent.provider].loginCommand(agent);
      const shell = process.env.SHELL || '/bin/zsh';
      const env: NodeJS.ProcessEnv = { ...agentEnv(agent), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      delete env.NO_COLOR;
      delete env.FORCE_COLOR;
      // An empty folder of its own: in ~ the CLI would ask you to trust your whole home folder
      // (and every permission saved there) just to sign in.
      const loginDir = path.join(path.dirname(ACCOUNTS_DIR), 'sign-in');
      fs.mkdirSync(loginDir, { recursive: true });
      let term: pty.IPty;
      try {
        term = pty.spawn(shell, cmd.length ? ['-l', '-c', 'exec "$@"', 'agent', ...cmd] : ['-l'], {
          name: 'xterm-256color', cols: msg.cols || 100, rows: msg.rows || 30, cwd: loginDir, env: env as Record<string, string>,
        });
      } catch (e) {
        send(ws, { t: 'login-error', error: `Could not start the sign-in terminal: ${(e as Error).message}` });
        return;
      }
      logins.set(ws, term);
      term.onData((data) => send(ws, { t: 'login-out', data }));
      term.onExit(({ exitCode }) => {
        if (logins.get(ws) === term) logins.delete(ws);
        send(ws, { t: 'login-exit', code: exitCode });
      });
    } else if (msg.t === 'login-in') {
      logins.get(ws)?.write(msg.data);
    } else if (msg.t === 'login-resize' && msg.cols > 0 && msg.rows > 0) {
      logins.get(ws)?.resize(msg.cols, msg.rows);
    } else if (msg.t === 'login-stop') {
      logins.get(ws)?.kill();
      logins.delete(ws);
    }
  }
}

// ---------- migration from the single-project layout ----------

/** Version 0.2 kept one log/task list in data/. Move it into a project for the folder the agents used. */
function migrateSingleProjectData() {
  const oldFiles = ['events.jsonl', 'tasks.json', 'sessions.json'].filter((f) => fs.existsSync(path.join(DATA, f)));
  if (!oldFiles.length) return;
  const folder = team.list.map((a) => a.cwd).find((c) => c && fs.existsSync(c));
  if (folder) {
    const project = projects.add(path.basename(folder), folder);
    const dest = path.join(DATA, 'projects', project.id);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of oldFiles) fs.renameSync(path.join(DATA, f), path.join(dest, f));
    // Those agents now simply follow whichever project is open.
    for (const a of team.list) if (a.cwd === folder) team.update(a.id, { cwd: '' });
  } else {
    for (const f of oldFiles) fs.renameSync(path.join(DATA, f), path.join(DATA, `${f}.old`));
  }
}

// ---------- lifecycle ----------

function shutdown() {
  for (const o of orchestrators.values()) o.stopAll();
  killAllProcesses();
  for (const t of logins.values()) t.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// One failing request or agent must never take the whole console (and every running agent) down.
process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaught exception]', err));

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (probably another Agent Workers server). Stop it, or run with PORT=<other port>.`);
    process.exit(1);
  }
  console.error('[server error]', err);
});
server.listen(PORT, HOST, () => {
  console.log(`Agent Workers console: http://${HOST}:${PORT}`);
});
