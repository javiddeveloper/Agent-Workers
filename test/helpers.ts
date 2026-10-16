// Test helpers: a throwaway project folder and an orchestrator whose agents use a fake CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADAPTERS, type TurnInput } from '../server/adapters.ts';
import { Orchestrator } from '../server/orchestrator.ts';
import { AgentStore } from '../server/store.ts';
import type { AgentConfig, TurnResult } from '../server/types.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-test-'));
}

/** Replaces the "custom" provider's turn with fn, so no real process runs. */
export function fakeTurn(fn: (input: TurnInput) => Promise<TurnResult>) {
  ADAPTERS.custom.runTurn = fn;
}

/** Resolves when the turn is aborted, after a short delay like a real process exiting. */
export function untilAborted(signal: AbortSignal, exitDelay = 100): Promise<TurnResult> {
  return new Promise((resolve) => {
    const done = () => setTimeout(() => resolve({ ok: false, finalText: '', error: 'killed' }), exitDelay);
    if (signal.aborted) done();
    else signal.addEventListener('abort', done, { once: true });
  });
}

export function setup(agents: Partial<AgentConfig>[], dir = tempDir()) {
  const projectDir = path.join(dir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const team = new AgentStore(path.join(dir, 'agents.json'));
  for (const a of agents) team.add({ provider: 'custom', command: 'fake', ...a });
  const project = { id: 'p', name: 'p', path: projectDir, createdAt: '' };
  const orch = new Orchestrator(project, team, path.join(dir, 'data'));
  return { orch, team, dir, projectDir };
}

/** Waits until cond() is true (or fails after timeout ms). */
export async function waitFor(cond: () => boolean, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}
