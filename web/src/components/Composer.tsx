import { useEffect, useRef, useState } from 'react';
import { papi, type AgentView } from '../api.ts';
import { Avatar, ROLE_SHORT } from './ui.tsx';

export function Composer({ agents, defaultTarget }: { agents: AgentView[]; defaultTarget: string }) {
  const [target, setTarget] = useState(defaultTarget);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setTarget(defaultTarget), [defaultTarget]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [text]);

  const agent = agents.find((a) => a.id === target);

  async function send() {
    if (!text.trim() || !target || sending) return;
    setSending(true);
    setError('');
    try {
      await papi('POST', '/send', { to: target, text });
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <div className="composer-target">
          <Avatar agent={agent} size={22} />
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {ROLE_SHORT[a.role]}</option>)}
          </select>
        </div>
        <textarea
          ref={ref}
          dir="auto"
          rows={1}
          value={text}
          placeholder={agent ? `Message ${agent.name}…  (Enter to send, Shift+Enter for a new line)` : 'Add an agent first'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
        />
        <button className="btn primary send" disabled={!text.trim() || !target || sending} onClick={send}>Send</button>
      </div>
      {error && <div className="composer-error">{error}</div>}
    </div>
  );
}
