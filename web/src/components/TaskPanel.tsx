import { useState } from 'react';
import { papi, type AgentView, type Task } from '../api.ts';
import { agentName, timeOf } from './ui.tsx';

const GROUPS: { status: Task['status']; label: string }[] = [
  { status: 'working', label: 'In progress' },
  { status: 'queued', label: 'Queued' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
  { status: 'cancelled', label: 'Cancelled' },
];

export function TaskPanel({ tasks, agents }: { tasks: Task[]; agents: AgentView[] }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({ done: true, cancelled: true });
  return (
    <aside className="tasks">
      <div className="side-head"><span>Tasks</span></div>
      {tasks.length === 0 && <p className="muted pad">The lead's delegated tasks show up here.</p>}
      {GROUPS.map(({ status, label }) => {
        const list = tasks.filter((t) => t.status === status).sort((a, b) => b.id - a.id);
        if (!list.length) return null;
        return (
          <section key={status} className="task-group">
            <button className="group-head" onClick={() => setClosed((c) => ({ ...c, [status]: !c[status] }))}>
              {closed[status] ? '▸' : '▾'} {label} <span className="count">{list.length}</span>
            </button>
            {!closed[status] && list.map((t) => <TaskItem key={t.id} t={t} agents={agents} />)}
          </section>
        );
      })}
    </aside>
  );
}

function TaskItem({ t, agents }: { t: Task; agents: AgentView[] }) {
  const [open, setOpen] = useState(false);
  const to = agents.find((a) => a.id === t.to);
  return (
    <div className={`task ${t.status}`} style={{ borderLeftColor: to?.color }} onClick={() => setOpen((o) => !o)}>
      <div className="task-top">
        <span className="task-id">#{t.id}</span>
        <span className="task-route">{agentName(agents, t.from)} → {agentName(agents, t.to)}</span>
        <span className="time">{timeOf(t.updatedAt)}</span>
      </div>
      <div className="task-title" dir="auto">{t.title}</div>
      {open && t.details && <div className="task-text" dir="auto">{t.details}</div>}
      {open && t.result && <div className="task-text result" dir="auto">{t.result}</div>}
      {(t.status === 'queued' || t.status === 'working') && (
        <button className="link" onClick={(e) => { e.stopPropagation(); papi('POST', `/tasks/${t.id}/cancel`); }}>Cancel</button>
      )}
    </div>
  );
}
