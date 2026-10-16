import { useEffect, useMemo, useState } from 'react';
import { api, papi, useAppState, type AgentView } from './api.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { Feed } from './components/Feed.tsx';
import { Composer } from './components/Composer.tsx';
import { TaskPanel } from './components/TaskPanel.tsx';
import { AgentModal } from './components/AgentModal.tsx';
import { LoginModal } from './components/LoginModal.tsx';
import { Welcome } from './components/Welcome.tsx';
import { CheckpointsModal, ProjectModal, ProjectSwitcher } from './components/Projects.tsx';

function load(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}

export function App() {
  const state = useAppState();
  const { project } = state;
  const [focus, setFocus] = useState<string | null>(null); // agent filter for the console
  const [editing, setEditing] = useState<AgentView | 'new' | null>(null);
  const [loginFor, setLoginFor] = useState<AgentView | null>(null);
  const [projectModal, setProjectModal] = useState(false);
  const [checkpoints, setCheckpoints] = useState(false);
  const [showTasks, setShowTasks] = useState(load('aw-tasks', '1') === '1');
  const [showTools, setShowTools] = useState(load('aw-steps', '0') === '1');

  useEffect(() => store('aw-tasks', showTasks ? '1' : '0'), [showTasks]);
  useEffect(() => store('aw-steps', showTools ? '1' : '0'), [showTools]);
  useEffect(() => { if (focus && !state.agents.some((a) => a.id === focus)) setFocus(null); }, [state.agents, focus]);
  useEffect(() => { setFocus(null); }, [project?.id]);

  const lead = useMemo(() => state.agents.find((a) => a.role === 'lead') ?? state.agents[0], [state.agents]);
  const working = state.agents.filter((a) => a.status === 'working').length;
  const busy = state.agents.some((a) => a.status === 'working' || a.queued > 0);
  const { paused, autoTurns, autoTurnBudget } = state.status;
  const ready = !!project && state.agents.length > 0;

  return (
    <div className={`app ${showTasks && ready ? '' : 'no-tasks'}`}>
      <header className="topbar">
        <div className="brand"><span className="logo">◆</span> Agent Workers</div>
        <ProjectSwitcher
          project={project}
          projects={state.projects}
          editors={state.editors}
          onNew={() => setProjectModal(true)}
          onCheckpoints={() => setCheckpoints(true)}
        />
        <div className="spacer" />
        {ready && (
          <>
            <div className={`pill ${state.connected ? (paused ? 'warn' : working ? 'live' : '') : 'bad'}`}>
              {!state.connected ? 'Disconnected' : paused ? 'Paused' : working ? `${working} working` : 'Idle'}
            </div>
            <div className="budget" title="Automatic agent turns since your last message. The team pauses at the limit so it can't burn your quota in a loop.">
              Auto turns {autoTurns}/{autoTurnBudget}
            </div>
            {paused && <button className="btn primary" onClick={() => papi('POST', '/resume')}>Resume</button>}
            <button className="btn ghost" title="Undo the team's changes" onClick={() => setCheckpoints(true)}>Checkpoints</button>
            <button className="btn danger-ghost" disabled={!busy} onClick={() => papi('POST', '/stop-all')}>Stop all</button>
            <button className={`btn ghost ${showTasks ? 'on' : ''}`} onClick={() => setShowTasks((v) => !v)}>
              Tasks {state.tasks.filter((t) => t.status === 'working' || t.status === 'queued').length || ''}
            </button>
          </>
        )}
      </header>

      <Sidebar
        agents={state.agents}
        providers={state.providers}
        focus={focus}
        onFocus={setFocus}
        onAdd={() => setEditing('new')}
        onEdit={setEditing}
        onLogin={setLoginFor}
      />

      <main className="console">
        {!state.connected ? (
          <div className="feed-empty">Connecting…</div>
        ) : !ready ? (
          <Welcome hasProject={!!project} agents={state.agents} onNewProject={() => setProjectModal(true)} onCustomAgent={() => setEditing('new')} />
        ) : (
          <>
            {!project.exists && <div className="banner warn inset">The folder {project.path} no longer exists.</div>}
            {project.exists && !project.git && (
              <div className="banner inset">
                Undo is off: this folder has no git repository, so no checkpoints are saved before requests.
                <button className="btn small primary" onClick={() => api('POST', `/projects/${project.id}/git-init`)}>Enable checkpoints</button>
              </div>
            )}
            <Feed
              events={state.events}
              agents={state.agents}
              focus={focus}
              projectPath={project.path}
              showTools={showTools}
              onToggleTools={() => setShowTools((v) => !v)}
              onCheckpoints={() => setCheckpoints(true)}
              onClear={() => confirm('Clear the console history for this project? Agents keep their own context.') && papi('DELETE', '/events')}
            />
            <Composer agents={state.agents} defaultTarget={focus ?? lead?.id ?? ''} />
          </>
        )}
      </main>

      {showTasks && ready && <TaskPanel tasks={state.tasks} agents={state.agents} />}

      {editing && (
        <AgentModal
          agent={editing === 'new' ? null : editing}
          providers={state.providers}
          roles={state.roles}
          agents={state.agents}
          home={state.home}
          onClose={() => setEditing(null)}
          onLogin={(a) => { setEditing(null); setLoginFor(a); }}
        />
      )}
      {loginFor && <LoginModal agent={loginFor} onClose={() => setLoginFor(null)} />}
      {projectModal && <ProjectModal home={state.home} onClose={() => setProjectModal(false)} />}
      {checkpoints && project && <CheckpointsModal project={project} busy={busy} onClose={() => setCheckpoints(false)} />}
    </div>
  );
}
