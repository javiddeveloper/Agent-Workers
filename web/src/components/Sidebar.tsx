import { useState } from 'react';
import { api, papi, type AgentView, type ProviderInfo } from '../api.ts';
import { Avatar, PROVIDER_SHORT, ROLE_SHORT, StatusDot, formatTokens } from './ui.tsx';

interface Props {
  agents: AgentView[];
  providers: ProviderInfo[];
  focus: string | null;
  onFocus: (id: string | null) => void;
  onAdd: () => void;
  onEdit: (a: AgentView) => void;
  onLogin: (a: AgentView) => void;
}

const ROLE_ORDER = { lead: 0, custom: 1, worker: 2, reviewer: 3 } as const;

export function Sidebar({ agents, focus, onFocus, onAdd, onEdit, onLogin }: Props) {
  const [menu, setMenu] = useState<string | null>(null);
  const sorted = [...agents].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);

  return (
    <aside className="sidebar" onClick={() => setMenu(null)}>
      <div className="side-head">
        <span>Team</span>
        <button className="btn small primary" onClick={onAdd}>+ Agent</button>
      </div>

      <button className={`side-item all ${focus === null ? 'active' : ''}`} onClick={() => onFocus(null)}>
        <span className="all-icon">≡</span>
        <span className="side-name">All activity</span>
      </button>

      <div className="side-list">
        {sorted.map((a) => (
          <div
            key={a.id}
            className={`side-item ${focus === a.id ? 'active' : ''}`}
            onClick={() => onFocus(focus === a.id ? null : a.id)}
          >
            <Avatar agent={a} />
            <div className="side-body">
              <div className="side-row">
                <span className="side-name">{a.name}</span>
                <span className={`role-tag ${a.role}`}>{ROLE_SHORT[a.role]}</span>
              </div>
              <div className="side-meta">
                <StatusDot status={a.status} />
                <span>{PROVIDER_SHORT[a.provider]}{a.model ? ` · ${a.model}` : ''}</span>
                {a.account !== 'default' && <span className="acct">@{a.account}</span>}
              </div>
              {(a.status === 'working' || a.queued > 0 || a.tokens > 0) && (
                <div className="side-meta small">
                  {a.status === 'working' && <span className="working">working…</span>}
                  {a.queued > 0 && <span>{a.queued} queued</span>}
                  {a.tokens > 0 && <span>{formatTokens(a.tokens)} tok</span>}
                  {a.costUsd > 0 && <span>${a.costUsd.toFixed(2)}</span>}
                </div>
              )}
              {a.status === 'error' && a.lastError && <div className="side-error" title={a.lastError}>{a.lastError}</div>}
            </div>
            <button
              className="kebab"
              title="Actions"
              onClick={(e) => { e.stopPropagation(); setMenu(menu === a.id ? null : a.id); }}
            >⋯</button>
            {menu === a.id && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => { setMenu(null); onEdit(a); }}>Edit…</button>
                <button onClick={() => { setMenu(null); onLogin(a); }}>Sign in / account terminal…</button>
                <button onClick={() => { setMenu(null); papi('POST', `/agents/${a.id}/reset`); }}>New conversation</button>
                <button disabled={a.status !== 'working' && !a.queued} onClick={() => { setMenu(null); papi('POST', `/agents/${a.id}/stop`); }}>Stop</button>
                <hr />
                <button className="danger" onClick={() => { setMenu(null); if (confirm(`Remove ${a.name}?`)) api('DELETE', `/agents/${a.id}`); }}>Remove</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
