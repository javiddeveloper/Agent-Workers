import { useState } from 'react';
import { api, type AgentConfig, type AgentView } from '../api.ts';

type Seed = Partial<AgentConfig>;

const TEMPLATES: { name: string; desc: string; agents: Seed[] }[] = [
  {
    name: 'Claude team',
    desc: 'Opus lead, two Sonnet workers',
    agents: [
      { name: 'lead', provider: 'claude', model: 'opus', role: 'lead', permission: 'readonly' },
      { name: 'claude-1', provider: 'claude', model: 'sonnet', role: 'worker', permission: 'auto' },
      { name: 'claude-2', provider: 'claude', model: 'sonnet', role: 'worker', permission: 'auto' },
    ],
  },
  {
    name: 'Gemini leads, Claude builds',
    desc: 'Gemini lead, two Claude workers',
    agents: [
      { name: 'lead', provider: 'gemini', model: 'auto', role: 'lead', permission: 'readonly' },
      { name: 'claude-1', provider: 'claude', model: 'sonnet', role: 'worker', permission: 'auto' },
      { name: 'claude-2', provider: 'claude', model: 'sonnet', role: 'worker', permission: 'auto' },
    ],
  },
  {
    name: 'Mixed team',
    desc: 'Claude lead; Claude, Gemini and Antigravity workers',
    agents: [
      { name: 'lead', provider: 'claude', model: 'opus', role: 'lead', permission: 'readonly' },
      { name: 'claude-1', provider: 'claude', model: 'sonnet', role: 'worker', permission: 'auto' },
      { name: 'gemini-1', provider: 'gemini', model: 'auto', role: 'worker', permission: 'auto' },
      { name: 'agy-1', provider: 'antigravity', role: 'worker', permission: 'auto' },
    ],
  },
];

/** First run: pick a project, then a team. */
export function Welcome({ hasProject, agents, onNewProject, onCustomAgent }: {
  hasProject: boolean;
  agents: AgentView[];
  onNewProject: () => void;
  onCustomAgent: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create(seeds: Seed[]) {
    setBusy(true);
    setError('');
    try {
      for (const s of seeds) await api('POST', '/agents', s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!hasProject) {
    return (
      <div className="welcome">
        <div className="step">Step 1 of 2</div>
        <h1>What should the team work on?</h1>
        <p className="muted">
          A project is a folder on your Mac. The agents read and write its files directly, run its commands and tests,
          and you open the same folder in your editor to see the result. Before every request a checkpoint is saved so you can undo.
        </p>
        <div className="templates">
          <button className="template" onClick={onNewProject}>
            <b>Start a new project</b>
            <small>An empty folder the team builds from scratch</small>
          </button>
          <button className="template" onClick={onNewProject}>
            <b>Open an existing folder</b>
            <small>Let the team work on code you already have</small>
          </button>
        </div>
        {agents.length > 0 && <p className="muted small">Your team ({agents.map((a) => a.name).join(', ')}) works on whichever project is open.</p>}
      </div>
    );
  }

  return (
    <div className="welcome">
      <div className="step">Step 2 of 2</div>
      <h1>Build your team</h1>
      <p className="muted">
        Each agent is an AI CLI with its own model, account and role. The lead talks to you and hands tasks to the others.
        The same team works on all your projects.
      </p>
      <div className="templates">
        {TEMPLATES.map((t) => (
          <button key={t.name} className="template" disabled={busy} onClick={() => create(t.agents)}>
            <b>{t.name}</b>
            <small>{t.desc}</small>
          </button>
        ))}
        <button className="template outline" onClick={onCustomAgent}>
          <b>+ Start from scratch</b>
          <small>Add agents one by one</small>
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
      <p className="muted small">You can change any agent's provider, model, role or account later.</p>
    </div>
  );
}
