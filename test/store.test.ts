import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { AgentStore } from '../server/store.ts';
import { tempDir } from './helpers.ts';

test('a new agent gets its own account named after it', () => {
  const team = new AgentStore(path.join(tempDir(), 'agents.json'));
  assert.equal(team.add({ name: 'Worker 1' }).account, 'worker-1');
  assert.equal(team.add({ name: 'Worker 1', account: '  ' }).account, 'worker-1-2');
  assert.equal(team.add({ name: 'lead', account: 'default' }).account, 'default');
  assert.equal(team.add({ name: 'gem', account: 'shared' }).account, 'shared');
});

test('editing an agent keeps its account', () => {
  const team = new AgentStore(path.join(tempDir(), 'agents.json'));
  team.add({ name: 'w', account: 'default' });
  assert.equal(team.update('w', { model: 'opus' }).account, 'default');
});
