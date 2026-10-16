import { useEffect, useState } from 'react';
import { api, openProject, type Checkpoint, type EditorInfo, type Project, type ProjectView } from '../api.ts';
import { FolderPicker } from './FolderPicker.tsx';
import { timeOf } from './ui.tsx';

// ---------- top-bar switcher ----------

interface SwitcherProps {
  project: ProjectView | null;
  projects: Project[];
  editors: EditorInfo[];
  onNew: () => void;
  onCheckpoints: () => void;
}

export function ProjectSwitcher({ project, projects, editors, onNew, onCheckpoints }: SwitcherProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  return (
    <div className="project-switch" onClick={(e) => e.stopPropagation()}>
      <button className="project-btn" onClick={() => setOpen((o) => !o)}>
        <span className="project-name">{project?.name ?? 'No project'}</span>
        {project && <span className="project-path mono">{shortPath(project.path)}</span>}
        <span className="caret">▾</span>
      </button>
      {project && (
        <div className="open-in">
          {editors.slice(0, 2).map((e) => (
            <button key={e.id} className="btn small ghost" onClick={() => api('POST', `/projects/${project.id}/open`, { app: e.id })}>{e.label}</button>
          ))}
          <button className="btn small ghost" onClick={() => api('POST', `/projects/${project.id}/open`, { app: 'finder' })}>Finder</button>
        </div>
      )}
      {open && (
        <div className="menu project-menu">
          <div className="menu-label">Projects</div>
          {projects.map((p) => (
            <button key={p.id} className={p.id === project?.id ? 'current' : ''} onClick={() => { setOpen(false); openProject(p.id); }}>
              <b>{p.name}</b>
              <small className="mono">{shortPath(p.path)}</small>
            </button>
          ))}
          <hr />
          <button onClick={() => { setOpen(false); onNew(); }}>+ New or existing project…</button>
          {project && (
            <>
              <button onClick={() => { setOpen(false); onCheckpoints(); }}>Checkpoints (undo changes)…</button>
              {editors.slice(2).map((e) => (
                <button key={e.id} onClick={() => { setOpen(false); api('POST', `/projects/${project.id}/open`, { app: e.id }); }}>Open in {e.label}</button>
              ))}
              <button onClick={() => { setOpen(false); api('POST', `/projects/${project.id}/open`, { app: 'terminal' }); }}>Open in Terminal</button>
              <button onClick={() => {
                setOpen(false);
                const name = prompt('Project name', project.name);
                if (name) api('PUT', `/projects/${project.id}`, { name });
              }}>Rename…</button>
              <hr />
              <button className="danger" onClick={() => {
                setOpen(false);
                if (confirm(`Remove "${project.name}" from the list? The folder and its files stay on disk.`)) api('DELETE', `/projects/${project.id}`);
              }}>Remove from list</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function shortPath(p: string) {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

// ---------- new / open project ----------

export function ProjectModal({ home, onClose }: { home: string; onClose: () => void }) {
  const [mode, setMode] = useState<'new' | 'open'>('new');
  const [name, setName] = useState('');
  const [parent, setParent] = useState(`${home}/Documents/Projects`);
  const [folder, setFolder] = useState('');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [parentIsProject, setParentIsProject] = useState(false);

  // Creating a "new project" inside an existing project is almost always a mistake.
  useEffect(() => {
    if (mode !== 'new') return;
    const t = setTimeout(() => {
      api<{ isProject: boolean }>('GET', `/folder-info?path=${encodeURIComponent(parent)}`)
        .then((i) => setParentIsProject(i.isProject)).catch(() => setParentIsProject(false));
    }, 250);
    return () => clearTimeout(t);
  }, [parent, mode]);

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const body = mode === 'new' ? { name, folder: parent, create: true } : { name: name || folder.split('/').filter(Boolean).pop(), folder };
      const p = await api<Project>('POST', '/projects', body);
      openProject(p.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Project</h2>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="choice-grid two-col">
            <button className={`choice ${mode === 'new' ? 'on' : ''}`} onClick={() => { setMode('new'); setPicking(false); }}>
              <b>New project</b><small>Creates an empty folder with git; the team builds it from scratch.</small>
            </button>
            <button className={`choice ${mode === 'open' ? 'on' : ''}`} onClick={() => { setMode('open'); setPicking(true); }}>
              <b>Existing folder</b><small>The team works on code you already have.</small>
            </button>
          </div>

          {mode === 'new' ? (
            <>
              <label className="field">
                <span>Name</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. shop-website" />
              </label>
              <label className="field">
                <span>Create inside</span>
                <div className="input-row">
                  <input className="mono" value={parent} onChange={(e) => setParent(e.target.value)} />
                  <button type="button" className="btn ghost" onClick={() => setPicking((p) => !p)}>Browse…</button>
                </div>
                {picking && <FolderPicker start={parent} onPick={(p) => { setParent(p); setPicking(false); }} />}
                {name.trim() && <small className="mono">→ {shortPath(`${parent.replace(/\/$/, '')}/${name.trim()}`)}</small>}
              </label>
              {parentIsProject && (
                <div className="banner warn">
                  {shortPath(parent)} is already a project. A new, empty project would be created inside it.
                  <button className="btn small primary" onClick={() => { setMode('open'); setFolder(parent); setPicking(false); }}>Open this folder instead</button>
                </div>
              )}
            </>
          ) : (
            <>
              <label className="field">
                <span>Folder</span>
                <div className="input-row">
                  <input className="mono" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={`${home}/Documents/Projects/my-app`} />
                  <button type="button" className="btn ghost" onClick={() => setPicking((p) => !p)}>Browse…</button>
                </div>
                {picking && <FolderPicker start={folder || `${home}/Documents/Projects`} onPick={(p) => { setFolder(p); setPicking(false); }} />}
              </label>
              <label className="field">
                <span>Name <em>(optional)</em></span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={folder.split('/').filter(Boolean).pop() || 'folder name'} />
              </label>
            </>
          )}
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || (mode === 'new' ? !name.trim() : !folder.trim())} onClick={submit}>
            {mode === 'new' ? 'Create project' : 'Open project'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- checkpoints ----------

export function CheckpointsModal({ project, busy, onClose }: { project: ProjectView; busy: boolean; onClose: () => void }) {
  const [list, setList] = useState<Checkpoint[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api<Checkpoint[]>('GET', `/projects/${project.id}/checkpoints`).then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function restore(cp: Checkpoint) {
    if (!confirm(`Put all project files back to how they were at ${new Date(cp.ts).toLocaleString()}?\n\nChanges made after that are undone. (A checkpoint of the current state is saved first, so this can be undone too.)`)) return;
    try {
      await api('POST', `/projects/${project.id}/checkpoints/${cp.id}/restore`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Checkpoints · {project.name}</h2>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {!project.git ? (
            <div className="banner">
              Checkpoints need git in this folder.
              <button className="btn small primary" onClick={() => api('POST', `/projects/${project.id}/git-init`).then(load)}>Enable checkpoints</button>
            </div>
          ) : (
            <p className="muted small">A snapshot of every file is saved before each message you send. Restoring puts the files back; your own git commits and branches are never touched.</p>
          )}
          {busy && <div className="banner warn">Agents are working. Stop them before restoring.</div>}
          {error && <div className="form-error">{error}</div>}
          <div className="cp-list">
            {list?.length === 0 && <p className="muted">No checkpoints yet. One is saved the next time you send a message.</p>}
            {list?.map((cp) => (
              <div key={cp.id} className="cp">
                <div className="cp-main">
                  <div className="cp-label" dir="auto">{cp.label.replace(/^Before: /, '')}</div>
                  <div className="muted small">{new Date(cp.ts).toLocaleDateString()} {timeOf(cp.ts)} · <span className="mono">{cp.id.slice(0, 8)}</span></div>
                </div>
                <button className="btn small ghost" disabled={busy} onClick={() => restore(cp)}>Restore</button>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-foot"><div className="spacer" /><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
