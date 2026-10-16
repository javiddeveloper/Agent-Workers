// Git checkpoints: a snapshot of the whole project (tracked + untracked, respecting .gitignore)
// taken before each request, stored as commits under refs/agent-workers/. They never touch
// your branch, your staging area or your working tree, so your own git history stays clean.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Checkpoint } from './types.ts';

const REF_PREFIX = 'refs/agent-workers/checkpoints/';

// Git can hang on some folders (e.g. files evicted to iCloud). A checkpoint must never block a request.
const GIT_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err && (err as { killed?: boolean }).killed) reject(new Error(`git ${args[0]} took longer than ${GIT_TIMEOUT_MS / 1000}s and was stopped`));
      else if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim() === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

export async function initRepo(dir: string) {
  await git(dir, ['init', '-q']);
}

/** Runs fn with a throwaway index file so the user's staging area is never touched. */
async function withTempIndex<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-index-')), 'index');
  try {
    return await fn({ GIT_INDEX_FILE: file });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

async function snapshotTree(dir: string): Promise<string> {
  return withTempIndex(async (env) => {
    await git(dir, ['add', '-A', '.'], env);
    return (await git(dir, ['write-tree'], env)).trim();
  });
}

export async function listCheckpoints(dir: string): Promise<Checkpoint[]> {
  if (!(await isGitRepo(dir))) return [];
  const out = await git(dir, ['for-each-ref', '--sort=-refname', '--format=%(objectname)%09%(creatordate:iso-strict)%09%(contents:subject)', REF_PREFIX]);
  return out.trim().split('\n').filter(Boolean).map((line) => {
    const [id, ts, ...label] = line.split('\t');
    return { id, ts, label: label.join('\t') };
  });
}

/** Saves a checkpoint unless nothing changed since the last one. Returns it, or null. */
export async function createCheckpoint(dir: string, label: string): Promise<Checkpoint | null> {
  if (!(await isGitRepo(dir))) return null;
  const tree = await snapshotTree(dir);
  const [last] = await listCheckpoints(dir);
  if (last && (await git(dir, ['rev-parse', `${last.id}^{tree}`])).trim() === tree) return null;
  const parents: string[] = [];
  try { parents.push('-p', (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).trim()); } catch {}
  const subject = label.replace(/\s+/g, ' ').trim().slice(0, 120) || 'checkpoint';
  const sha = (await git(dir, ['commit-tree', tree, ...parents, '-m', subject], {
    GIT_AUTHOR_NAME: 'Agent Workers', GIT_AUTHOR_EMAIL: 'agent-workers@localhost',
    GIT_COMMITTER_NAME: 'Agent Workers', GIT_COMMITTER_EMAIL: 'agent-workers@localhost',
  })).trim();
  const ts = new Date().toISOString();
  await git(dir, ['update-ref', `${REF_PREFIX}${ts.replace(/[:.]/g, '-')}`, sha]);
  return { id: sha, ts, label: subject };
}

/**
 * Puts the project's files back exactly as they were at the checkpoint: changed files are
 * restored and files created since are deleted. Ignored files (node_modules, .env…) are left alone.
 * A checkpoint of the current state is saved first, so a restore can itself be undone.
 */
export async function restoreCheckpoint(dir: string, id: string) {
  if (!/^[0-9a-f]{7,40}$/.test(id)) throw new Error('bad checkpoint id');
  await createCheckpoint(dir, 'Before restoring a checkpoint');
  const target = new Set((await git(dir, ['ls-tree', '-r', '--name-only', '-z', id])).split('\0').filter(Boolean));
  const current = await withTempIndex(async (env) => {
    await git(dir, ['add', '-A', '.'], env);
    return (await git(dir, ['ls-files', '-z'], env)).split('\0').filter(Boolean);
  });
  const touchedDirs = new Set<string>();
  for (const file of current) {
    if (target.has(file)) continue;
    fs.rmSync(path.join(dir, file), { force: true });
    touchedDirs.add(path.dirname(file));
  }
  await withTempIndex(async (env) => {
    await git(dir, ['read-tree', id], env);
    await git(dir, ['checkout-index', '-a', '-f'], env);
  });
  // Remove folders that only held deleted files.
  for (let rel of touchedDirs) {
    while (rel && rel !== '.') {
      const abs = path.join(dir, rel);
      try { if (fs.readdirSync(abs).length) break; fs.rmdirSync(abs); } catch { break; }
      rel = path.dirname(rel);
    }
  }
}
