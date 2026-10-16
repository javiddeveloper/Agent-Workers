import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit/lib/addon-fit.mjs';

const TOKEN = window.AGENT_WORKERS_TOKEN;
const $ = (sel, root = document) => root.querySelector(sel);

let state = { agents: [], tasks: [], accounts: [], roleTemplates: {} };
const terms = new Map(); // agentId -> { term, fit, card, lastOutput }
let ws;
let editingId = null;

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || res.statusText); throw new Error(data.error); }
  return data;
}

// ---------- WebSocket ----------
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${TOKEN}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'state') { state = msg; render(); }
    else if (msg.t === 'replay') {
      const t = ensureTerm(msg.id);
      if (!t) return;
      // Replayed output contains old terminal queries; xterm would answer them and the
      // answers (e.g. "1;2c") would be typed into the agent. Mute input until it's done.
      t.replaying = true;
      t.term.reset();
      t.term.write(msg.data, () => { t.replaying = false; });
    }
    else if (msg.t === 'out') {
      const t = ensureTerm(msg.id);
      if (!t) return;
      t.term.write(msg.data);
      t.lastOutput = Date.now();
      t.card.classList.add('busy');
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

// The "busy" glow fades once an agent has been quiet for a few seconds.
setInterval(() => {
  for (const t of terms.values()) if (Date.now() - (t.lastOutput || 0) > 3000) t.card.classList.remove('busy');
}, 1000);

// ---------- terminals ----------
function ensureTerm(id) {
  if (terms.has(id)) return terms.get(id);
  const agent = state.agents.find((a) => a.id === id);
  if (!agent) return null;

  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = id;
  card.innerHTML = `
    <div class="card-head">
      <span class="dot"></span>
      <strong class="name"></strong>
      <span class="badge role"></span>
      <span class="meta"></span>
      <span class="spacer"></span>
      <button data-act="start" title="Start / restart">⟳</button>
      <button data-act="stop" title="Stop">■</button>
      <button data-act="edit" title="Edit">✎</button>
      <button data-act="max" title="Maximize">⤢</button>
      <button data-act="remove" title="Remove">✕</button>
    </div>
    <div class="term"></div>`;
  $('#grid').appendChild(card);

  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0e1116', foreground: '#d6dae0' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open($('.term', card));
  term.onData((data) => { if (!entry.replaying) send({ t: 'input', id, data }); });
  term.onResize(({ cols, rows }) => send({ t: 'resize', id, cols, rows }));

  const entry = { term, fit, card, lastOutput: 0 };
  terms.set(id, entry);
  new ResizeObserver(() => { try { fit.fit(); } catch {} }).observe($('.term', card));

  card.addEventListener('click', async (ev) => {
    const act = ev.target.closest('button')?.dataset.act;
    if (!act) return;
    if (act === 'start') await api('POST', `/agents/${id}/start`, { cols: term.cols, rows: term.rows });
    if (act === 'stop') await api('POST', `/agents/${id}/stop`);
    if (act === 'edit') openAgentDialog(state.agents.find((a) => a.id === id));
    if (act === 'max') { card.classList.toggle('max'); setTimeout(() => fit.fit(), 50); }
    if (act === 'remove' && confirm(`Remove agent "${id}"? Its process will be stopped.`)) await api('DELETE', `/agents/${id}`);
  });
  return entry;
}

function renderCards() {
  const ids = new Set(state.agents.map((a) => a.id));
  for (const [id, t] of terms) {
    if (!ids.has(id)) { t.term.dispose(); t.card.remove(); terms.delete(id); }
  }
  for (const agent of state.agents) {
    const entry = ensureTerm(agent.id);
    const { card, term } = entry;
    card.classList.toggle('stopped', !agent.running);
    // A freshly started process gets a default size; tell it the real one.
    if (agent.running && !entry.wasRunning) send({ t: 'resize', id: agent.id, cols: term.cols, rows: term.rows });
    entry.wasRunning = agent.running;
    $('.name', card).textContent = agent.name;
    const role = $('.role', card);
    role.textContent = agent.role;
    role.dataset.role = agent.role;
    const open = state.tasks.filter((t) => t.to === agent.id && t.status !== 'done').length;
    $('.meta', card).textContent = [
      agent.cli === 'custom' ? agent.command : agent.cli,
      agent.model,
      agent.account && agent.account !== 'default' ? `@${agent.account}` : '',
      open ? `${open} task${open > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' · ');
  }
  $('#empty').hidden = state.agents.length > 0;
}

// ---------- board ----------
const STATUS_ORDER = { doing: 0, blocked: 1, open: 2, done: 3 };
function renderBoard() {
  const options = state.agents.map((a) => `<option value="${a.id}">${esc(a.name)} (${a.role})</option>`).join('');
  for (const sel of document.querySelectorAll('#task-form select, #send-form select')) {
    const prev = sel.value;
    sel.innerHTML = options;
    if (prev) sel.value = prev;
  }
  const showDone = $('#show-done').checked;
  const tasks = state.tasks
    .filter((t) => showDone || t.status !== 'done')
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.id - a.id);
  $('#tasks').innerHTML = tasks.length ? tasks.map((t) => `
    <div class="task" data-status="${t.status}">
      <div class="task-head">
        <span class="status">${t.status}</span>
        <span class="id">#${t.id}</span>
        <span class="route">${esc(t.from)} → ${esc(t.to)}</span>
        <button data-del="${t.id}" title="Delete">✕</button>
      </div>
      <div class="title">${esc(t.title)}</div>
      ${t.details ? `<div class="details">${esc(t.details)}</div>` : ''}
      ${t.result ? `<div class="result">${esc(t.result)}</div>` : ''}
    </div>`).join('') : '<p class="muted">No tasks.</p>';
}

$('#tasks').addEventListener('click', async (ev) => {
  const id = ev.target.dataset.del;
  if (id) await api('DELETE', `/tasks/${id}`);
});
$('#show-done').addEventListener('change', renderBoard);

$('#task-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  await api('POST', '/tasks', { to: f.to.value, title: f.title.value, details: f.details.value });
  f.title.value = '';
  f.details.value = '';
});
$('#send-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const r = await api('POST', '/send', { to: f.to.value, message: f.message.value });
  if (!r.delivered) alert('Agent is not running.');
  f.message.value = '';
});

// ---------- agent dialog ----------
const dialog = $('#agent-dialog');
const form = $('#agent-form');

function syncCliFields() {
  const custom = form.cli.value === 'custom';
  form.querySelectorAll('.only-custom').forEach((el) => (el.hidden = !custom));
  form.querySelectorAll('.not-custom').forEach((el) => (el.hidden = custom));
}
form.cli.addEventListener('change', syncCliFields);
form.role.addEventListener('change', () => {
  form.instructions.value = state.roleTemplates[form.role.value] || '';
});

function openAgentDialog(agent) {
  editingId = agent?.id || null;
  dialog.returnValue = '';
  $('#agent-dialog-title').textContent = agent ? `Edit ${agent.name}` : 'New agent';
  $('#agent-save').textContent = agent ? 'Save and restart' : 'Create and start';
  $('#accounts').innerHTML = ['default', ...state.accounts].map((a) => `<option value="${esc(a)}">`).join('');
  const a = agent || { cli: 'claude', account: 'default', role: 'coder', model: '', cwd: '', extraArgs: '', command: '', autoApprove: false };
  form.name.value = a.name || '';
  form.cli.value = a.cli;
  form.command.value = a.command || '';
  form.account.value = a.account || 'default';
  form.model.value = a.model || '';
  form.role.value = a.role;
  form.instructions.value = a.instructions ?? state.roleTemplates[a.role] ?? '';
  form.cwd.value = a.cwd || '';
  form.extraArgs.value = a.extraArgs || '';
  form.autoApprove.checked = !!a.autoApprove;
  syncCliFields();
  dialog.showModal();
}

dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'save') return;
  const body = {
    name: form.name.value.trim(),
    cli: form.cli.value,
    command: form.command.value.trim(),
    account: form.account.value.trim() || 'default',
    model: form.model.value.trim(),
    role: form.role.value,
    instructions: form.instructions.value,
    cwd: form.cwd.value.trim(),
    extraArgs: form.extraArgs.value.trim(),
    autoApprove: form.autoApprove.checked,
  };
  if (editingId) {
    await api('PUT', `/agents/${editingId}`, body);
    await api('POST', `/agents/${editingId}/start`);
  } else {
    await api('POST', '/agents', body);
  }
});

$('#add-agent').addEventListener('click', () => openAgentDialog(null));

// ---------- layout ----------
const colsSel = $('#cols');
function applyCols() {
  document.documentElement.style.setProperty('--cols', colsSel.value);
  try { localStorage.setItem('aw-cols', colsSel.value); } catch {}
}
try { colsSel.value = localStorage.getItem('aw-cols') || '2'; } catch {}
colsSel.addEventListener('change', applyCols);
applyCols();

$('#toggle-board').addEventListener('click', () => {
  document.body.classList.toggle('board-hidden');
  try { localStorage.setItem('aw-board-hidden', document.body.classList.contains('board-hidden') ? '1' : ''); } catch {}
});
try { if (localStorage.getItem('aw-board-hidden')) document.body.classList.add('board-hidden'); } catch {}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() { renderCards(); renderBoard(); }
connect();
