#!/usr/bin/env node
// `board` CLI: how agents read and write the shared task board.
const URL_BASE = process.env.BOARD_URL;
const TOKEN = process.env.BOARD_TOKEN;
const ME = process.env.AGENT_ID || 'user';

if (!URL_BASE || !TOKEN) {
  console.error('board: BOARD_URL / BOARD_TOKEN not set (run this inside an Agent Workers terminal)');
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(URL_BASE + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const fmt = (t) => `#${t.id} [${t.status}] ${t.from} -> ${t.to}: ${t.title}${t.result ? `\n    result: ${t.result}` : ''}`;

const USAGE = `usage:
  board agents
  board list [--mine] [--all]
  board show <id>
  board add <agent> "<title>" ["<details>"]
  board start <id>
  board done <id> "<result>"
  board block <id> "<reason>"
  board reopen <id>
  board send <agent> "<message>"`;

const [cmd, ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'agents': {
      for (const a of await api('GET', '/agents')) {
        console.log(`${a.id}${a.id === ME ? ' (you)' : ''}  role=${a.role}  cli=${a.cli}${a.model ? ` model=${a.model}` : ''}  ${a.running ? 'running' : 'stopped'}`);
      }
      break;
    }
    case 'list': {
      let tasks = await api('GET', '/tasks');
      if (args.includes('--mine')) tasks = tasks.filter((t) => t.to === ME);
      if (!args.includes('--all')) tasks = tasks.filter((t) => t.status !== 'done');
      console.log(tasks.length ? tasks.map(fmt).join('\n') : '(no tasks)');
      break;
    }
    case 'show': {
      const t = (await api('GET', '/tasks')).find((x) => x.id === Number(args[0]));
      if (!t) throw new Error(`no task #${args[0]}`);
      console.log(fmt(t));
      if (t.details) console.log(`    details: ${t.details}`);
      break;
    }
    case 'add': {
      const [to, title, ...rest] = args;
      if (!to || !title) throw new Error('usage: board add <agent> "<title>" ["<details>"]');
      const t = await api('POST', '/tasks', { to, title, details: rest.join(' '), from: ME });
      console.log(`created task #${t.id} for ${to}${t.delivered ? '' : ' (agent not running; it will see it on start)'}`);
      break;
    }
    case 'start':
    case 'done':
    case 'block':
    case 'reopen': {
      const [id, ...rest] = args;
      if (!id) throw new Error(`usage: board ${cmd} <id>`);
      const t = await api('POST', `/tasks/${id}/${cmd}`, { result: rest.length ? rest.join(' ') : undefined, by: ME });
      console.log(fmt(t));
      break;
    }
    case 'send': {
      const [to, ...rest] = args;
      if (!to || !rest.length) throw new Error('usage: board send <agent> "<message>"');
      const r = await api('POST', '/send', { to, message: rest.join(' '), from: ME });
      console.log(r.delivered ? 'sent' : 'agent not running; message not delivered');
      break;
    }
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help') process.exit(1);
  }
} catch (e) {
  console.error('board: ' + e.message);
  process.exit(1);
}
