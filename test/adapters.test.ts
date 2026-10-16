import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADAPTERS, agentCwd, claudeStreamParser } from '../server/adapters.ts';
import type { AgentConfig, LogEvent } from '../server/types.ts';
import { tempDir } from './helpers.ts';

const agent = (over: Partial<AgentConfig>): AgentConfig => ({
  id: 'a', name: 'a', provider: 'custom', account: 'default', model: '', role: 'worker',
  instructions: '', cwd: tempDir(), permission: 'readonly', sandbox: false, ...over,
});

test('Claude parser keeps every text block, not only the final reply', () => {
  const emitted: Partial<LogEvent>[] = [];
  const p = claudeStreamParser((e) => emitted.push(e));
  const lines = [
    { type: 'system', session_id: 'abc' },
    { type: 'assistant', message: { content: [{ type: 'text', text: '<task to="w" title="t">do</task>' }, { type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'file' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Delegated.' }] } },
    { type: 'result', result: 'Delegated.', total_cost_usd: 0.1, usage: { input_tokens: 5, output_tokens: 7 } },
  ];
  for (const l of lines) p.onLine(JSON.stringify(l));
  assert.equal(p.state.sessionId, 'abc');
  assert.equal(p.state.finalText, 'Delegated.');
  assert.match(p.state.texts.join('\n'), /<task to="w"/);
  assert.equal(p.state.tokens, 12);
  assert.deepEqual(emitted.map((e) => e.kind), ['text', 'tool', 'tool_result', 'text']);
});

test('custom command replaces {prompt} inside an argument', async () => {
  const prompt = 'hello $& world';
  const res = await ADAPTERS.custom.runTurn({
    agent: agent({ command: 'printf %s --message={prompt}' }),
    prompt, systemPrompt: '', signal: new AbortController().signal, emit: () => {},
  });
  assert.equal(res.ok, true, res.error ?? '');
  assert.equal(res.finalText, `--message=${prompt}`);
});

test('custom command still appends the prompt when there is no {prompt}', async () => {
  const res = await ADAPTERS.custom.runTurn({
    agent: agent({ command: 'printf %s' }),
    prompt: 'appended', systemPrompt: '', signal: new AbortController().signal, emit: () => {},
  });
  assert.equal(res.finalText, 'appended');
});

test('agents never fall back to the home folder', () => {
  assert.throws(() => agentCwd(agent({ cwd: '/definitely/not/here' })), /folder not found/);
  assert.throws(() => agentCwd(agent({ cwd: '' })), /folder not found/);
});
