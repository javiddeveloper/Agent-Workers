// Agent Workers: a dashboard of AI CLI terminals (Claude Code, Gemini CLI, ...)
// with per-agent accounts, roles, and a shared task board the agents talk through.
import express from 'express';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const ACCOUNTS_DIR = process.env.AGENT_WORKERS_ACCOUNTS || path.join(os.homedir(), '.agent-workers', 'accounts');
const PORT = Number(process.env.PORT || 4777);
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(16).toString('hex');
const SCROLLBACK_LIMIT = 256 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistence ----------
function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return fallback; }
}
function save(name, value) {
  const file = path.join(DATA_DIR, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

let agents = load('agents.json', []);
let board = load('tasks.json', { nextId: 1, tasks: [] });
const saveAgents = () => save('agents.json', agents);
const saveBoard = () => save('tasks.json', board);

// ---------- role prompts ----------
export const ROLE_TEMPLATES = {
  orchestrator:
    'You are the ORCHESTRATOR of a team of AI agents. Do not write code yourself. ' +
    'Turn the user\'s requests into small, concrete, independent tasks and assign each to a suitable agent with `board add <agent> "<title>" "<details>"`. ' +
    'Run `board agents` to see the team and their roles, and `board list` to see progress. ' +
    'When a task result arrives, check it, then assign follow-ups or report back to the user. Keep task descriptions precise so agents need no extra context.',
  coder:
    'You are a CODER on a team of AI agents. Tasks arrive as messages starting with "[board]". ' +
    'For each task: run `board start <id>`, implement it, verify it (build/tests), then run `board done <id> "<one or two sentence summary>"`. ' +
    'If you cannot finish, run `board block <id> "<reason>"`. Stay strictly within the task scope; other agents may be editing other files.',
  reviewer:
    'You are a REVIEWER on a team of AI agents. Tasks arrive as messages starting with "[board]". ' +
    'For each task: run `board start <id>`, review the referenced code for bugs and risky changes, then `board done <id> "<findings>"`. Do not rewrite code unless the task asks for it.',
};

function boardHelp(agent) {
  return [
    `Your agent id is "${agent.id}". You share a task board with other agents via the \`board\` command:`,
    '  board agents                         list team members and roles',
    '  board list [--mine] [--all]          list tasks',
    '  board show <id>                      task details',
    '  board add <agent> "<title>" ["<details>"]   assign a task (the agent is notified)',
    '  board start <id> | done <id> "<result>" | block <id> "<reason>"',
    '  board send <agent> "<message>"       send a short direct message',
    'Messages from the board appear in your input prefixed with "[board]".',
  ].join('\n');
}

function systemText(agent) {
  const role = agent.instructions?.trim() || ROLE_TEMPLATES[agent.role] || '';
  return [role, '', boardHelp(agent)].join('\n').trim();
}

// ---------- accounts ----------
function accountEnv(agent) {
  const env = {};
  const account = (agent.account || '').trim();
  if (!account || account === 'default') return env;
  const safe = account.replace(/[^a-zA-Z0-9._-]/g, '_');
  const base = path.join(ACCOUNTS_DIR, safe);
  if (agent.cli === 'claude') {
    env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
  } else if (agent.cli === 'gemini') {
    env.GEMINI_CLI_HOME = path.join(base, 'gemini');
  }
  for (const dir of Object.values(env)) fs.mkdirSync(dir, { recursive: true });
  return env;
}

function listAccounts() {
  try { return fs.readdirSync(ACCOUNTS_DIR).filter((d) => !d.startsWith('.')); } catch { return []; }
}

// ---------- command building ----------
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function buildCommand(agent) {
  const extra = splitArgs(agent.extraArgs);
  const kickoff = 'Run `board list --mine` and start on any open tasks assigned to you; if there are none, say you are ready and wait.';
  const orchestratorKickoff = 'Run `board agents` to see your team, then say you are ready and wait for the user\'s request.';
  const first = agent.role === 'orchestrator' ? orchestratorKickoff : kickoff;
  switch (agent.cli) {
    case 'claude': {
      const args = [];
      if (agent.model) args.push('--model', agent.model);
      if (agent.autoApprove) args.push('--dangerously-skip-permissions');
      // `board` itself never needs a permission prompt. Must precede another flag: --allowedTools is variadic.
      args.push('--allowedTools', 'Bash(board:*)');
      args.push('--append-system-prompt', systemText(agent), ...extra, first);
      return ['claude', args];
    }
    case 'gemini': {
      const args = [];
      if (agent.model) args.push('-m', agent.model);
      if (agent.autoApprove) args.push('--approval-mode', 'yolo');
      args.push('--allowed-tools', 'run_shell_command(board)');
      args.push(...extra, '-i', `${systemText(agent)}\n\n${first}`);
      return ['gemini', args];
    }
    case 'custom': {
      const [cmd, ...rest] = splitArgs(agent.command);
      return [cmd, [...rest, ...extra]];
    }
    default:
      return [null, []];
  }
}

// ---------- running terminals ----------
const sessions = new Map(); // agentId -> { pty, scrollback, running, exitCode }
const sizes = new Map(); // agentId -> last { cols, rows } the dashboard reported

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

function sessionState(id) {
  const s = sessions.get(id);
  return s ? { running: s.running, exitCode: s.exitCode } : { running: false, exitCode: null };
}

function publicState() {
  return {
    t: 'state',
    agents: agents.map((a) => ({ ...a, ...sessionState(a.id) })),
    tasks: board.tasks,
    accounts: listAccounts(),
    roleTemplates: ROLE_TEMPLATES,
  };
}
const pushState = () => broadcast(publicState());

function startAgent(agent, size = {}) {
  const { cols, rows } = { cols: 120, rows: 32, ...sizes.get(agent.id), ...size };
  stopAgent(agent.id);
  const shell = process.env.SHELL || '/bin/zsh';
  const [cmd, args] = buildCommand(agent);
  // A login shell gives the agent the user's normal PATH; `exec "$@"` avoids any quoting issues.
  const shellArgs = cmd ? ['-l', '-c', 'exec "$@"', 'agent', cmd, ...args] : ['-l'];
  const cwd = agent.cwd && fs.existsSync(agent.cwd) ? agent.cwd : os.homedir();
  const agentEnv = accountEnv(agent);
  const env = {
    ...process.env,
    ...agentEnv,
    AGENT_ID: agent.id,
    AGENT_NAME: agent.name,
    BOARD_URL: `http://${HOST}:${PORT}`,
    BOARD_TOKEN: TOKEN,
    PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH}`,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  // Don't let a parent Claude Code session (e.g. the dashboard launched from Claude) leak into children.
  for (const key of Object.keys(env)) {
    if ((key.startsWith('CLAUDE') && !(key in agentEnv)) || key === '__CFBundleIdentifier') delete env[key];
  }

  const term = pty.spawn(shell, shellArgs, { name: 'xterm-256color', cols, rows, cwd, env });
  const s = { pty: term, scrollback: '', running: true, exitCode: null };
  sessions.set(agent.id, s);
  term.onData((data) => {
    s.scrollback = (s.scrollback + data).slice(-SCROLLBACK_LIMIT);
    broadcast({ t: 'out', id: agent.id, data });
  });
  term.onExit(({ exitCode }) => {
    if (sessions.get(agent.id) !== s) return;
    s.running = false;
    s.exitCode = exitCode;
    const note = `\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`;
    s.scrollback += note;
    broadcast({ t: 'out', id: agent.id, data: note });
    pushState();
  });
  pushState();
}

function stopAgent(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  if (s.running) try { s.pty.kill(); } catch {}
}

// Type a message into an agent's input as if the user pasted it, then press Enter.
function deliver(agentId, text) {
  const s = sessions.get(agentId);
  if (!s?.running) return false;
  const line = `[board] ${text}`.replace(/\s*\n\s*/g, ' ');
  s.pty.write(`\x1b[200~${line}\x1b[201~`);
  setTimeout(() => s.running && s.pty.write('\r'), 400);
  return true;
}

// ---------- task board ----------
function nameOf(id) {
  return agents.find((a) => a.id === id)?.name || id;
}

function createTask({ to, title, details = '', from = 'user' }) {
  if (!agents.some((a) => a.id === to)) throw new Error(`unknown agent "${to}"`);
  if (!title?.trim()) throw new Error('title is required');
  const now = new Date().toISOString();
  const task = { id: board.nextId++, to, from, title: title.trim(), details, status: 'open', result: '', createdAt: now, updatedAt: now };
  board.tasks.push(task);
  saveBoard();
  const body = details ? `${task.title} — ${details}` : task.title;
  task.delivered = deliver(to, `Task #${task.id} from ${nameOf(from)}: ${body}  (when finished: board done ${task.id} "<summary>")`);
  pushState();
  return task;
}

function updateTask(id, status, result, by) {
  const task = board.tasks.find((t) => t.id === Number(id));
  if (!task) throw new Error(`no task #${id}`);
  task.status = status;
  if (result !== undefined) task.result = result;
  task.updatedAt = new Date().toISOString();
  saveBoard();
  if ((status === 'done' || status === 'blocked') && task.from !== 'user' && task.from !== by) {
    const verb = status === 'done' ? 'done' : 'BLOCKED';
    deliver(task.from, `Task #${task.id} "${task.title}" ${verb} by ${nameOf(by || task.to)}: ${result || '(no details)'}`);
  }
  pushState();
  return task;
}

// ---------- agents CRUD ----------
function slug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  let id = base;
  for (let i = 2; agents.some((a) => a.id === id); i++) id = `${base}-${i}`;
  return id;
}

const AGENT_FIELDS = ['name', 'cli', 'account', 'model', 'role', 'instructions', 'cwd', 'autoApprove', 'extraArgs', 'command'];
function pickAgentFields(body) {
  const out = {};
  for (const k of AGENT_FIELDS) if (k in body) out[k] = body[k];
  if ('cwd' in out && out.cwd) out.cwd = out.cwd.replace(/^~(?=$|\/)/, os.homedir());
  return out;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  res.type('html').send(html.replace('__TOKEN__', TOKEN));
});
app.use(express.static(path.join(ROOT, 'public'), { index: false }));
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(ROOT, 'node_modules', '@xterm', 'addon-fit')));

app.use('/api', (req, res, next) => {
  if (req.get('x-token') !== TOKEN) return res.status(401).json({ error: 'bad token' });
  next();
});
const wrap = (fn) => (req, res) => {
  try { res.json(fn(req) ?? { ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
};

app.get('/api/state', wrap(() => publicState()));
app.get('/api/agents', wrap(() => agents.map((a) => ({ id: a.id, name: a.name, cli: a.cli, role: a.role, model: a.model, ...sessionState(a.id) }))));
app.post('/api/agents', wrap((req) => {
  const fields = pickAgentFields(req.body);
  if (!fields.name?.trim()) throw new Error('name is required');
  const agent = { cli: 'claude', role: 'coder', account: 'default', autoApprove: false, ...fields, id: slug(fields.name) };
  agents.push(agent);
  saveAgents();
  if (req.body.start !== false) startAgent(agent); else pushState();
  return agent;
}));
app.put('/api/agents/:id', wrap((req) => {
  const agent = agents.find((a) => a.id === req.params.id);
  if (!agent) throw new Error('no such agent');
  Object.assign(agent, pickAgentFields(req.body));
  saveAgents();
  pushState();
  return agent;
}));
app.delete('/api/agents/:id', wrap((req) => {
  stopAgent(req.params.id);
  agents = agents.filter((a) => a.id !== req.params.id);
  saveAgents();
  pushState();
}));
app.post('/api/agents/:id/start', wrap((req) => {
  const agent = agents.find((a) => a.id === req.params.id);
  if (!agent) throw new Error('no such agent');
  startAgent(agent, req.body);
}));
app.post('/api/agents/:id/stop', wrap((req) => { stopAgent(req.params.id); pushState(); }));

app.get('/api/tasks', wrap(() => board.tasks));
app.post('/api/tasks', wrap((req) => createTask(req.body)));
app.post('/api/tasks/:id/:action(start|done|block|reopen)', wrap((req) => {
  const status = { start: 'doing', done: 'done', block: 'blocked', reopen: 'open' }[req.params.action];
  return updateTask(req.params.id, status, req.body.result, req.body.by);
}));
app.delete('/api/tasks/:id', wrap((req) => {
  board.tasks = board.tasks.filter((t) => t.id !== Number(req.params.id));
  saveBoard();
  pushState();
}));
app.post('/api/send', wrap((req) => {
  const { to, message, from = 'user' } = req.body;
  if (!agents.some((a) => a.id === to)) throw new Error(`unknown agent "${to}"`);
  return { delivered: deliver(to, `Message from ${nameOf(from)}: ${message}`) };
}));

// ---------- WebSocket (terminal I/O) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const origin = req.headers.origin || '';
  const okOrigin = origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== TOKEN || !okOrigin) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(publicState()));
  for (const [id, s] of sessions) ws.send(JSON.stringify({ t: 'replay', id, data: s.scrollback }));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'resize' && msg.cols > 0 && msg.rows > 0) sizes.set(msg.id, { cols: Math.floor(msg.cols), rows: Math.floor(msg.rows) });
    const s = sessions.get(msg.id);
    if (!s?.running) return;
    if (msg.t === 'input') s.pty.write(msg.data);
    else if (msg.t === 'resize' && sizes.has(msg.id)) s.pty.resize(sizes.get(msg.id).cols, sizes.get(msg.id).rows);
  });
});

// Agents that were running last time are started again.
for (const agent of agents) if (agent.autoStart !== false) startAgent(agent);

function shutdown() {
  for (const id of [...sessions.keys()]) stopAgent(id);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`Agent Workers dashboard: http://${HOST}:${PORT}`);
});
