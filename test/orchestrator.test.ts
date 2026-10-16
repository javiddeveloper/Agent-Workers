import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeTurn, setup, sleep, tempDir, untilAborted, waitFor } from './helpers.ts';

const view = (orch: ReturnType<typeof setup>['orch'], id: string) => orch.agentViews().find((a) => a.id === id)!;

test('a message sent right after Stop still gets a turn', async () => {
  const prompts: string[] = [];
  fakeTurn(async ({ prompt, signal }) => {
    prompts.push(prompt);
    if (prompts.length === 1) return untilAborted(signal, 150);
    return { ok: true, finalText: 'ok' };
  });
  const { orch } = setup([{ name: 'w', role: 'worker' }]);
  await orch.sendFromUser('w', 'first');
  await waitFor(() => view(orch, 'w').status === 'working');
  orch.stopAgent('w');
  await orch.sendFromUser('w', 'second'); // the first process is still exiting
  await waitFor(() => prompts.length === 2);
  await waitFor(() => view(orch, 'w').status === 'idle');
  assert.match(prompts[1], /second/);
  assert.equal(view(orch, 'w').queued, 0);
});

test('a user message to one agent resumes the whole paused team', async () => {
  fakeTurn(async () => ({ ok: true, finalText: 'done' }));
  const { orch } = setup([{ name: 'lead', role: 'lead' }, { name: 'w', role: 'worker' }]);
  orch.autoTurnBudget = 0;
  const task = orch.createTask('lead', 'w', 'job', 'do it');
  await waitFor(() => orch.paused);
  assert.equal(view(orch, 'w').queued, 1);
  orch.autoTurnBudget = 60;
  await orch.sendFromUser('lead', 'hi');
  await waitFor(() => orch.tasks.find((t) => t.id === task.id)!.status === 'done');
  assert.equal(orch.paused, false);
});

test('a corrupted line in the event log does not lose the rest of the history', () => {
  const dir = tempDir();
  const ev = (id: number) => JSON.stringify({ id, ts: '', agentId: 'system', kind: 'system', text: `e${id}` });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'events.jsonl'), `${ev(1)}\n{"id":2,"ts":"\n${ev(7)}\n${ev(3)}\n`);
  const { orch } = setup([], dir);
  assert.deepEqual(orch.events.map((e) => e.id), [1, 7, 3]);
  assert.equal(orch.log({ agentId: 'system', kind: 'system', text: 'new' }).id, 8);
});

test('events are written to disk in order', () => {
  const { orch, dir } = setup([]);
  for (let i = 0; i < 200; i++) orch.log({ agentId: 'system', kind: 'system', text: String(i) });
  const ids = fs.readFileSync(path.join(dir, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(ids.length, 200);
});

test('task tags in an earlier text block of the turn are not lost', async () => {
  fakeTurn(async ({ agent }) => agent.id === 'lead'
    ? { ok: true, finalText: 'Delegated, waiting for results.', allText: 'Plan:\n<task to="w" title="build">make it</task>\n\nDelegated, waiting for results.' }
    : { ok: true, finalText: 'built' });
  const { orch } = setup([{ name: 'lead', role: 'lead' }, { name: 'w', role: 'worker' }]);
  await orch.sendFromUser('lead', 'go');
  await waitFor(() => orch.tasks.some((t) => t.status === 'done'));
  assert.equal(orch.tasks[0].to, 'w');
  assert.equal(orch.tasks[0].title, 'build');
});

test('an agent does not run when its folder is missing', async () => {
  let ran = false;
  fakeTurn(async () => { ran = true; return { ok: true, finalText: 'ok' }; });
  const { orch, projectDir } = setup([{ name: 'w', role: 'worker' }]);
  fs.rmSync(projectDir, { recursive: true });
  await orch.sendFromUser('w', 'hello');
  await waitFor(() => view(orch, 'w').status === 'error');
  assert.equal(ran, false);
  assert.match(view(orch, 'w').lastError ?? '', /folder not found/);
});

test('cancelling a task that is running stops the agent', async () => {
  let aborted = false;
  fakeTurn(async ({ signal }) => { const r = await untilAborted(signal, 20); aborted = true; return r; });
  const { orch } = setup([{ name: 'lead', role: 'lead' }, { name: 'w', role: 'worker' }]);
  const task = orch.createTask('lead', 'w', 'long job', 'takes forever');
  await waitFor(() => task.status === 'working');
  orch.cancelTask(task.id);
  await waitFor(() => aborted && view(orch, 'w').status === 'stopped');
  assert.equal(task.status, 'cancelled');
  await sleep(50);
  // Cancelled work is not reported back to the lead as a result.
  assert.equal(view(orch, 'lead').queued, 0);
});

test('CLIs without a system prompt flag get the prompt again when it changes', async () => {
  const prompts: string[] = [];
  fakeTurn(async ({ prompt }) => { prompts.push(prompt); return { ok: true, finalText: 'ok', sessionId: 's1' }; });
  const { orch, team } = setup([{ name: 'w', role: 'worker' }]);
  const turn = async (text: string) => {
    const n = prompts.length;
    await orch.sendFromUser('w', text);
    await waitFor(() => prompts.length === n + 1 && view(orch, 'w').status === 'idle');
    return prompts.at(-1)!;
  };
  assert.match(await turn('one'), /^You are "w"/);
  assert.doesNotMatch(await turn('two'), /You are "w"/);
  team.update('w', { instructions: 'Always write tests.' });
  const third = await turn('three');
  assert.match(third, /^\[Updated instructions/);
  assert.match(third, /Always write tests\./);
  team.add({ name: 'reviewer', role: 'reviewer', provider: 'custom', command: 'fake' });
  assert.match(await turn('four'), /- reviewer: Reviewer/);
  assert.doesNotMatch(await turn('five'), /You are "w"/);
});

test('a task for an unknown agent is reported back to the lead', async () => {
  const prompts: string[] = [];
  fakeTurn(async ({ prompt }) => {
    prompts.push(prompt);
    return prompts.length === 1
      ? { ok: true, finalText: '<task to="gem-1" title="build">do it</task>', sessionId: 's' }
      : { ok: true, finalText: 'ok', sessionId: 's' };
  });
  const { orch } = setup([{ name: 'lead', role: 'lead' }, { name: 'w', role: 'worker' }]);
  await orch.sendFromUser('lead', 'go');
  await waitFor(() => prompts.length === 2 && view(orch, 'lead').status === 'idle');
  assert.match(prompts[1], /\[From the orchestrator\] Your task for "gem-1" was not delivered/);
  assert.match(prompts[1], /- w: Worker/);
  assert.equal(orch.tasks.length, 0);
});

test('a worker that tries to delegate is told why it did not work', async () => {
  const prompts: string[] = [];
  fakeTurn(async ({ prompt }) => {
    prompts.push(prompt);
    return { ok: true, finalText: prompts.length === 1 ? '<task to="lead" title="x">y</task>' : 'ok' };
  });
  const { orch } = setup([{ name: 'lead', role: 'lead' }, { name: 'w', role: 'worker' }]);
  await orch.sendFromUser('w', 'go');
  await waitFor(() => prompts.length === 2);
  assert.match(prompts[1], /only a Lead \(or Custom role\) can delegate/);
});

test('the lead hears about agents that joined or left the team', async () => {
  const prompts: string[] = [];
  fakeTurn(async ({ prompt }) => { prompts.push(prompt); return { ok: true, finalText: 'ok', sessionId: 's' }; });
  const { orch, team } = setup([{ name: 'lead', role: 'lead' }, { name: 'coder', role: 'worker' }, { name: 'gem', role: 'worker' }]);
  const turn = async () => {
    const n = prompts.length;
    await orch.sendFromUser('lead', 'next');
    await waitFor(() => prompts.length === n + 1 && view(orch, 'lead').status === 'idle');
    return prompts.at(-1)!;
  };
  assert.doesNotMatch(await turn(), /Team update/); // new conversation: roster is in the system prompt
  assert.doesNotMatch(await turn(), /Team update/); // nothing changed
  team.remove('gem');
  team.add({ name: 'worker-1', role: 'worker', provider: 'antigravity' });
  const note = await turn();
  assert.match(note, /Joined the team \(give them work too\):\n- worker-1: Worker \(Antigravity\)/);
  assert.match(note, /Left the team \(do not send them anything\): gem/);
  assert.doesNotMatch(await turn(), /Team update/); // told once
});

test('a lead with an existing conversation gets the current team once after an upgrade', async () => {
  const prompts: string[] = [];
  fakeTurn(async ({ prompt }) => { prompts.push(prompt); return { ok: true, finalText: 'ok', sessionId: 's' }; });
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'sessions.json'), JSON.stringify({ lead: 'old-session' }));
  const { orch } = setup([{ name: 'lead', role: 'lead' }, { name: 'worker-1', role: 'worker' }], dir);
  await orch.sendFromUser('lead', 'hi');
  await waitFor(() => prompts.length === 1 && view(orch, 'lead').status === 'idle');
  assert.match(prompts[0], /^\[Team update from the orchestrator\] The team is now:\n- worker-1: Worker/);
});
