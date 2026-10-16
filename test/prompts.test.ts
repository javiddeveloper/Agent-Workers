import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemPrompt } from '../server/prompts.ts';
import type { AgentConfig } from '../server/types.ts';

const agent = (id: string, role: AgentConfig['role'], provider: AgentConfig['provider'] = 'claude'): AgentConfig => ({
  id, name: id, provider, account: id, model: '', role, instructions: '', cwd: '', permission: 'auto', sandbox: false,
});

test('the lead is told to spread work across the whole team', () => {
  const team = [agent('lead', 'lead'), agent('coder-1', 'worker'), agent('worker-1', 'worker', 'antigravity')];
  const p = systemPrompt(team[0], team, { id: 'p', name: 'p', path: '/tmp/p', createdAt: '' });
  assert.match(p, /spread independent tasks across all workers/);
  assert.doesNotMatch(p, /give tasks that touch the same files to the same agent/);
  assert.match(p, /- worker-1: Worker \(Antigravity\)/);
});
