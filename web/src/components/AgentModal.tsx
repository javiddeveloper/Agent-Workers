import { useEffect, useState } from 'react';
import { FolderPicker } from './FolderPicker.tsx';
import { api, type AgentConfig, type AgentView, type PermissionLevel, type ProviderInfo, type RoleInfo } from '../api.ts';

interface Props {
  agent: AgentView | null;
  providers: ProviderInfo[];
  roles: RoleInfo[];
  agents: AgentView[];
  home: string;
  onClose: () => void;
  onLogin: (a: AgentView) => void;
}

const PROVIDER_HINT: Record<string, string> = {
  claude: 'Claude Code CLI (claude)',
  gemini: 'Gemini CLI (gemini)',
  antigravity: 'Antigravity CLI (agy)',
  custom: 'Any CLI that takes a prompt and prints a reply',
};

const PERMISSIONS: { id: PermissionLevel; label: string; hint: string }[] = [
  { id: 'readonly', label: 'Read-only', hint: 'Plans and reads; changes nothing' },
  { id: 'edit', label: 'Edit files', hint: 'Edits files; can\'t run commands or tests' },
  { id: 'auto', label: 'Auto', hint: 'Edits and runs commands. Claude screens risky ones; Gemini/Antigravity don\'t' },
  { id: 'full', label: 'Full access', hint: 'Everything, no checks. Use with sandbox or a scratch folder' },
];

type Form = Omit<AgentConfig, 'id'>;

export function AgentModal({ agent, providers, roles, agents, home, onClose, onLogin }: Props) {
  const [form, setForm] = useState<Form>(() => agent ? { ...agent } : {
    name: suggestName(agents),
    provider: 'claude',
    account: '', // empty = a separate login named after the agent
    model: '',
    role: agents.some((a) => a.role === 'lead') ? 'worker' : 'lead',
    instructions: '',
    cwd: '',
    permission: agents.some((a) => a.role === 'lead') ? 'auto' : 'readonly',
    sandbox: false,
    command: '',
  });
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const provider = providers.find((p) => p.id === form.provider);
  const role = roles.find((r) => r.id === form.role);
  const accounts = Array.from(new Set(['default', ...agents.filter((a) => a.provider === form.provider).map((a) => a.account)]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(thenLogin = false) {
    setError('');
    try {
      const saved: AgentView = agent ? await api('PUT', `/agents/${agent.id}`, form) : await api('POST', '/agents', form);
      if (thenLogin) onLogin(saved);
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{agent ? `Edit ${agent.name}` : 'New agent'}</h2>
          <button className="x" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. lead, claude-coder, gem-2" autoFocus />
          </label>

          <div className="field">
            <span>Model provider</span>
            <div className="choice-grid four">
              {providers.map((p) => (
                <button key={p.id} type="button" className={`choice ${form.provider === p.id ? 'on' : ''}`} onClick={() => setForm((f) => ({ ...f, provider: p.id as Form['provider'], model: '' }))}>
                  <b>{p.label}</b>
                  <small>{PROVIDER_HINT[p.id]}</small>
                </button>
              ))}
            </div>
          </div>

          {form.provider === 'custom' ? (
            <label className="field">
              <span>Command</span>
              <input value={form.command ?? ''} onChange={(e) => set('command', e.target.value)} placeholder='e.g. codex exec {prompt}' className="mono" />
              <small>{'{prompt}'} is replaced by the message; without it the message is added at the end.</small>
            </label>
          ) : (
            <div className="two">
              <label className="field">
                <span>Model</span>
                <input list="model-list" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="CLI default" />
                <datalist id="model-list">{provider?.models.map((m) => <option key={m} value={m} />)}</datalist>
              </label>
              <label className="field">
                <span>Account</span>
                <input list="account-list" value={form.account} onChange={(e) => set('account', e.target.value)}
                  placeholder={agentSlug(form.name) || 'agent name'} />
                <datalist id="account-list">{accounts.map((a) => <option key={a} value={a} />)}</datalist>
                <small>{agent ? '"default" = your normal login. A new name = a separate login.' : 'Empty = its own login, named after the agent. "default" = your normal login.'}</small>
              </label>
            </div>
          )}

          <div className="field">
            <span>Role</span>
            <div className="choice-grid four">
              {roles.map((r) => (
                <button key={r.id} type="button" className={`choice ${form.role === r.id ? 'on' : ''}`} onClick={() => set('role', r.id as Form['role'])}>
                  <b>{r.label}</b>
                  <small>{ROLE_HINT[r.id]}</small>
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            <span>Instructions <em>(added to the role)</em></span>
            <textarea rows={3} dir="auto" value={form.instructions} onChange={(e) => set('instructions', e.target.value)}
              placeholder={role?.prompt || 'Describe what this agent should do.'} />
          </label>

          <label className="field">
            <span>Folder <em>(optional: empty = the open project's folder)</em></span>
            <div className="input-row">
              <input className="mono" value={form.cwd} onChange={(e) => set('cwd', e.target.value)} placeholder="Same as the project" />
              <button type="button" className="btn ghost" onClick={() => setPicking((p) => !p)}>Browse…</button>
            </div>
            {picking && <FolderPicker start={form.cwd || home} onPick={(p) => { set('cwd', p); setPicking(false); }} />}
          </label>

          <div className="field">
            <span>Permissions</span>
            <div className="choice-grid four">
              {PERMISSIONS.map((p) => (
                <button key={p.id} type="button" className={`choice ${form.permission === p.id ? 'on' : ''} ${p.id === 'full' ? 'risky' : ''}`} onClick={() => set('permission', p.id)}>
                  <b>{p.label}</b>
                  <small>{p.hint}</small>
                </button>
              ))}
            </div>
            {(form.provider === 'gemini' || form.provider === 'antigravity') && (
              <label className="check">
                <input type="checkbox" checked={form.sandbox} onChange={(e) => set('sandbox', e.target.checked)} />
                Run in sandbox (restricts what shell commands can touch)
              </label>
            )}
          </div>

          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="modal-foot">
          {form.provider !== 'custom' && (
            <button className="btn ghost" onClick={() => (agent ? onLogin(agent) : save(true))}>
              {agent ? 'Sign in…' : 'Create and sign in…'}
            </button>
          )}
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => save()}>{agent ? 'Save' : 'Create agent'}</button>
        </div>
      </div>
    </div>
  );
}

const ROLE_HINT: Record<string, string> = {
  lead: 'Talks to you, plans, delegates',
  worker: 'Implements assigned tasks',
  reviewer: 'Reviews work, reports issues',
  custom: 'Your instructions only; can delegate',
};

function suggestName(agents: AgentView[]) {
  if (!agents.some((a) => a.role === 'lead')) return 'lead';
  for (let i = 1; ; i++) if (!agents.some((a) => a.name === `worker-${i}`)) return `worker-${i}`;
}

/** The id the server will give a new agent (and so its own account name). */
function agentSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
