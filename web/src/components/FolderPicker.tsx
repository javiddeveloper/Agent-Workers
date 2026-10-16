import { useEffect, useState } from 'react';
import { api } from '../api.ts';

interface Listing { path: string; parent: string; folders: string[] }

export function FolderPicker({ start, onPick }: { start: string; onPick: (p: string) => void }) {
  const [dir, setDir] = useState<Listing | null>(null);
  const [err, setErr] = useState('');
  const open = (p: string) => api<Listing>('GET', `/folders?path=${encodeURIComponent(p)}`).then((d) => { setDir(d); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { open(start); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="picker"><div className="form-error pad">{err}</div><button className="link pad" onClick={() => open('~')}>Go to home folder</button></div>;
  if (!dir) return <div className="picker muted pad">Loading…</div>;
  return (
    <div className="picker">
      <div className="picker-head">
        <button type="button" className="btn small ghost" onClick={() => open(dir.parent)}>↑</button>
        <span className="mono picker-path">{dir.path}</span>
        <button type="button" className="btn small primary" onClick={() => onPick(dir.path)}>Use this folder</button>
      </div>
      <div className="picker-list">
        {dir.folders.length === 0 && <div className="muted pad">No subfolders</div>}
        {dir.folders.map((f) => <button type="button" key={f} onClick={() => open(`${dir.path}/${f}`)}>📁 {f}</button>)}
      </div>
    </div>
  );
}
