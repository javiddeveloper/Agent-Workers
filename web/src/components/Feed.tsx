import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentView, LogEvent } from '../api.ts';
import { Avatar, agentName, formatTokens, stripTags, timeOf } from './ui.tsx';
import { ActivityBlock, shorten } from './Activity.tsx';

const ACTIVITY_KINDS = new Set(['tool', 'tool_result', 'thinking']);

type Item =
  | { type: 'event'; e: LogEvent }
  | { type: 'activity'; agentId: string; events: LogEvent[]; key: number };

/** Collapses each run of tool events from one agent into a single activity item. */
function toItems(events: LogEvent[]): Item[] {
  const items: Item[] = [];
  for (const e of events) {
    const last = items.at(-1);
    if (ACTIVITY_KINDS.has(e.kind)) {
      if (last?.type === 'activity' && last.agentId === e.agentId) last.events.push(e);
      else items.push({ type: 'activity', agentId: e.agentId, events: [e], key: e.id });
    } else {
      items.push({ type: 'event', e });
    }
  }
  return items;
}

interface Props {
  events: LogEvent[];
  agents: AgentView[];
  focus: string | null;
  projectPath: string;
  showTools: boolean;
  onToggleTools: () => void;
  onCheckpoints: () => void;
  onClear: () => void;
}

export function Feed({ events, agents, focus, projectPath, showTools, onToggleTools, onCheckpoints, onClear }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const visible = useMemo(() => events.filter((e) => {
    if (focus && e.agentId !== focus && e.from !== focus && e.agentId !== 'system') return false;
    if (e.kind === 'text' && !stripTags(e.text)) return false;
    return true;
  }), [events, focus]);
  const items = useMemo(() => toItems(visible), [visible]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  useEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [focus]);

  const onScroll = () => {
    const el = scroller.current!;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stick.current = bottom;
    setAtBottom(bottom);
  };

  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const focused = focus ? byId.get(focus) : null;

  return (
    <div className="feed-wrap">
      <div className="feed-head">
        <span className="feed-title">{focused ? focused.name : 'All activity'}</span>
        <div className="spacer" />
        <label className="toggle">
          <input type="checkbox" checked={showTools} onChange={onToggleTools} /> Expand steps
        </label>
        <button className="btn small ghost" onClick={onClear}>Clear</button>
      </div>
      <div className="feed" ref={scroller} onScroll={onScroll}>
        {visible.length === 0 && <div className="feed-empty">Nothing here yet. Send a message below to get the team going.</div>}
        {items.map((item, i) => {
          const prev = items[i - 1];
          const agentId = item.type === 'event' ? item.e.agentId : item.agentId;
          const prevAgent = prev ? (prev.type === 'event' ? prev.e.agentId : prev.agentId) : null;
          const prevKind = prev?.type === 'event' ? prev.e.kind : 'activity';
          const kind = item.type === 'event' ? item.e.kind : 'activity';
          const newGroup = !prev || prevAgent !== agentId || ['turn_end', 'user', 'inbox', 'system', 'error'].includes(prevKind) || kind === 'user' || kind === 'inbox';
          const agent = byId.get(agentId);
          if (item.type === 'activity') {
            // Still running if this is the agent's latest output and it is working.
            const live = agent?.status === 'working' && !items.slice(i + 1).some((x) => (x.type === 'event' ? x.e.agentId : x.agentId) === agentId);
            return (
              <AgentRow key={`a${item.key}`} agent={agent} agentId={agentId} showHeader={newGroup} ts={item.events[0].ts}>
                <ActivityBlock events={item.events} root={projectPath} live={live} defaultOpen={showTools} />
              </AgentRow>
            );
          }
          return <EventRow key={item.e.id} e={item.e} agent={agent} agents={agents} root={projectPath} showHeader={newGroup} onCheckpoints={onCheckpoints} />;
        })}
        {items.length > 0 && <Thinking agents={agents} items={items} />}
      </div>
      {!atBottom && (
        <button className="jump" onClick={() => { const el = scroller.current!; el.scrollTop = el.scrollHeight; }}>↓ Latest</button>
      )}
    </div>
  );
}

function EventRow({ e, agent, agents, root, showHeader, onCheckpoints }: { e: LogEvent; agent?: AgentView; agents: AgentView[]; root: string; showHeader: boolean; onCheckpoints: () => void }) {
  switch (e.kind) {
    case 'user':
      return (
        <div className="row user">
          <div className="bubble user-bubble">
            <div className="bubble-head">You → {agentName(agents, e.agentId)} <span className="time">{timeOf(e.ts)}</span></div>
            <Rich text={e.text} />
          </div>
        </div>
      );
    case 'inbox': {
      const type = (e.meta?.type as string) ?? 'message';
      const from = agentName(agents, e.from ?? '');
      const to = agentName(agents, e.agentId);
      const fromAgent = agents.find((a) => a.id === e.from);
      if (type === 'task') {
        return (
          <Card className="task-card" accent={fromAgent?.color}
            head={<><span className="chip">Task #{e.taskId}</span> <b>{from}</b> → <b>{to}</b> <span className="card-title" dir="auto">{String(e.meta?.title ?? '')}</span></>}
            body={e.text} time={e.ts} />
        );
      }
      if (type === 'result') {
        const status = String(e.meta?.status ?? 'done');
        return (
          <Card className={`result-card ${status}`} accent={fromAgent?.color}
            head={<><span className={`chip ${status}`}>{status === 'done' ? '✓' : '!'} Result #{e.taskId}</span> <b>{from}</b> → <b>{to}</b> <span className="card-title" dir="auto">{String(e.meta?.title ?? '')}</span></>}
            body={e.text} time={e.ts} collapsed />
        );
      }
      return (
        <Card className="msg-card" accent={fromAgent?.color}
          head={<><span className="chip">Message</span> <b>{from}</b> → <b>{to}</b></>}
          body={e.text} time={e.ts} />
      );
    }
    case 'text':
      return (
        <AgentRow agent={agent} agentId={e.agentId} showHeader={showHeader} ts={e.ts}>
          <Rich text={shorten(stripTags(e.text), root)} />
        </AgentRow>
      );
    case 'turn_end': {
      const tokens = Number(e.meta?.tokens ?? 0);
      const cost = Number(e.meta?.costUsd ?? 0);
      if (!tokens && !cost) return null;
      return (
        <div className="turn-end">
          <span>{agent?.name} finished · {tokens ? `${formatTokens(tokens)} tokens` : ''}{cost ? ` · $${cost.toFixed(3)}` : ''}</span>
        </div>
      );
    }
    case 'error':
      return <div className="row notice error"><b>{agent?.name ?? e.agentId}:</b> <span dir="auto">{e.text}</span></div>;
    case 'system':
      return (
        <div className="row notice">
          <span dir="auto">{agent ? `${agent.name}: ` : ''}{e.text}</span>
          {Boolean(e.meta?.checkpoint) && <button className="link inline" onClick={onCheckpoints}>Undo…</button>}
        </div>
      );
    default:
      return null;
  }
}

function AgentRow({ agent, agentId, showHeader, ts, children }: { agent?: AgentView; agentId: string; showHeader: boolean; ts: string; children: ReactNode }) {
  return (
    <div className={`row agent ${showHeader ? '' : 'compact'}`}>
      {showHeader ? <Avatar agent={agent} size={26} /> : <span className="avatar-gap" />}
      <div className="agent-body">
        {showHeader && (
          <div className="agent-head">
            <b style={{ color: agent?.color }}>{agent?.name ?? agentId}</b>
            <span className="time">{timeOf(ts)}</span>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/** "lead is thinking…" for working agents whose latest output isn't a live activity line. */
function Thinking({ agents, items }: { agents: AgentView[]; items: Item[] }) {
  const last = items.at(-1)!;
  const lastAgent = last.type === 'event' ? last.e.agentId : last.agentId;
  const waiting = agents.filter((a) => a.status === 'working' && !(last.type === 'activity' && lastAgent === a.id));
  if (!waiting.length) return null;
  return (
    <div className="thinking-now">
      <span className="spinner" />
      {waiting.map((a) => <span key={a.id} style={{ color: a.color }}>{a.name}</span>).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}
      <span className="muted">{waiting.length > 1 ? 'are' : 'is'} working…</span>
    </div>
  );
}

function Card({ className, accent, head, body, time, collapsed }: { className: string; accent?: string; head: ReactNode; body: string; time: string; collapsed?: boolean }) {
  const long = body.length > 600 || body.split('\n').length > 10;
  const [open, setOpen] = useState(!collapsed || !long);
  return (
    <div className={`card ${className}`} style={{ borderLeftColor: accent }}>
      <div className="card-head">{head}<span className="time">{timeOf(time)}</span></div>
      {body && (
        <div className={`card-body ${open ? '' : 'clamped'}`}>
          <Rich text={body} />
        </div>
      )}
      {long && <button className="link" onClick={() => setOpen((o) => !o)}>{open ? 'Show less' : 'Show more'}</button>}
    </div>
  );
}

/** Minimal markdown: fenced code, inline code, bold, headings and lists. No HTML is injected. */
export function Rich({ text }: { text: string }) {
  const blocks = text.split(/```/);
  return (
    <div className="rich" dir="auto">
      {blocks.map((block, i) => {
        if (i % 2 === 1) {
          const nl = block.indexOf('\n');
          const code = nl >= 0 && /^[\w+-]*$/.test(block.slice(0, nl).trim()) ? block.slice(nl + 1) : block;
          return <pre key={i} className="code" dir="ltr">{code.replace(/\n$/, '')}</pre>;
        }
        return <Fragment key={i}>{renderLines(block.split('\n'), i)}</Fragment>;
      })}
    </div>
  );
}

function renderLines(lines: string[], blockIndex: number) {
  const out: ReactNode[] = [];
  for (let j = 0; j < lines.length; j++) {
    if (/^\s*\|.*\|\s*$/.test(lines[j])) {
      const start = j;
      while (j + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[j + 1])) j++;
      out.push(<Table key={`${blockIndex}-t${start}`} lines={lines.slice(start, j + 1)} />);
    } else {
      out.push(renderLine(lines[j], `${blockIndex}-${j}`));
    }
  }
  return out;
}

function Table({ lines }: { lines: string[] }) {
  const rows = lines
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c) || c === ''));
  const [head, ...body] = rows;
  return (
    <div className="table-wrap">
      <table dir="auto">
        <thead><tr>{head?.map((c, i) => <th key={i}>{inline(c)}</th>)}</tr></thead>
        <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function renderLine(line: string, key: string) {
  if (!line.trim()) return <div key={key} className="gap" />;
  const h = line.match(/^(#{1,4})\s+(.*)/);
  if (h) return <div key={key} className={`h h${h[1].length}`} dir="auto">{inline(h[2])}</div>;
  const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
  if (li) {
    return (
      <div key={key} className="li" dir="auto" style={{ paddingInlineStart: 12 + li[1].length * 6 }}>
        <span className="bullet">{/\d/.test(li[2]) ? li[2] : '•'}</span><span>{inline(li[3])}</span>
      </div>
    );
  }
  return <div key={key} dir="auto">{inline(line)}</div>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('`') ? <code key={m.index}>{tok.slice(1, -1)}</code> : <b key={m.index}>{tok.slice(2, -2)}</b>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
