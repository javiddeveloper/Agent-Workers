import { useState } from 'react';
import type { LogEvent } from '../api.ts';

// Turns a run of raw tool events into one compact line: "Read 6 files · Searched 3× · Edited todo.py",
// expandable into a tidy list. Tool names from Claude Code and Gemini CLI are both understood.

type Category = 'read' | 'search' | 'edit' | 'run' | 'web' | 'other';

const CATEGORY: Record<string, Category> = {
  read: 'read', read_file: 'read', read_many_files: 'read', notebookread: 'read',
  glob: 'search', grep: 'search', ls: 'search', list_directory: 'search', search_file_content: 'search', find_files: 'search',
  write: 'edit', edit: 'edit', multiedit: 'edit', notebookedit: 'edit', write_file: 'edit', replace: 'edit', edit_file: 'edit',
  bash: 'run', run_shell_command: 'run', shell: 'run',
  webfetch: 'web', websearch: 'web', web_fetch: 'web', google_web_search: 'web',
};

const VERB: Record<Category, string> = { read: 'Read', search: 'Search', edit: 'Edit', run: 'Run', web: 'Web', other: 'Tool' };
const ICON: Record<Category, string> = { read: '◧', search: '⌕', edit: '✎', run: '❯', web: '◍', other: '•' };
const LIVE_VERB: Record<Category, string> = { read: 'Reading', search: 'Searching', edit: 'Editing', run: 'Running', web: 'Looking up', other: 'Working' };

interface Step {
  id: number;
  kind: 'tool' | 'thinking';
  category: Category;
  name: string;
  arg: string;
  result?: string;
  error?: boolean;
}

function categorize(name = ''): Category {
  return CATEGORY[name.toLowerCase()] ?? 'other';
}

/** Pairs each tool call with its result (results arrive in call order). */
export function toSteps(events: LogEvent[]): Step[] {
  const steps: Step[] = [];
  const pending: Step[] = [];
  for (const e of events) {
    if (e.kind === 'tool') {
      const step: Step = { id: e.id, kind: 'tool', category: categorize(e.from), name: e.from ?? 'tool', arg: e.text };
      steps.push(step);
      pending.push(step);
    } else if (e.kind === 'tool_result') {
      const step = pending.shift();
      if (step) { step.result = e.text; step.error = Boolean(e.meta?.error); }
    } else if (e.kind === 'thinking') {
      steps.push({ id: e.id, kind: 'thinking', category: 'other', name: 'thinking', arg: e.text });
    }
  }
  return steps;
}

/** Makes paths relative to the project and the home folder short. */
export function shorten(text: string, root: string) {
  let out = text;
  if (root) out = out.split(root + '/').join('').split(root).join('.');
  return out.replace(/\/Users\/[^/\s]+/g, '~');
}

function fileName(arg: string) {
  const first = arg.split(/\s/)[0];
  return first.split('/').filter(Boolean).pop() ?? first;
}

function summary(steps: Step[]) {
  const tools = steps.filter((s) => s.kind === 'tool');
  const count = (c: Category) => tools.filter((s) => s.category === c).length;
  const parts: string[] = [];
  const reads = count('read');
  const searches = count('search');
  const runs = count('run');
  const web = count('web');
  const other = count('other');
  if (reads) parts.push(`Read ${reads} file${reads > 1 ? 's' : ''}`);
  if (searches) parts.push(`searched ${searches}×`);
  if (runs) parts.push(`ran ${runs} command${runs > 1 ? 's' : ''}`);
  if (web) parts.push(`${web} web lookup${web > 1 ? 's' : ''}`);
  if (other) parts.push(`${other} other step${other > 1 ? 's' : ''}`);
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface Props {
  events: LogEvent[];
  root: string;
  live: boolean;
  defaultOpen: boolean;
}

export function ActivityBlock({ events, root, live, defaultOpen }: Props) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? defaultOpen;
  const steps = toSteps(events);
  const tools = steps.filter((s) => s.kind === 'tool');
  const edited = [...new Set(tools.filter((s) => s.category === 'edit').map((s) => shorten(s.arg, root)))];
  const blocked = tools.filter((s) => s.error).length;
  const current = live ? [...tools].reverse().find((s) => s.result === undefined) ?? tools.at(-1) : undefined;
  const text = summary(steps.filter((s) => s.category !== 'edit'));

  return (
    <div className={`activity ${live ? 'live' : ''}`}>
      <button className="activity-line" onClick={() => setOpen(!isOpen)}>
        {live ? <span className="spinner" /> : <span className="chev">{isOpen ? '▾' : '▸'}</span>}
        {edited.length > 0 && (
          <span className="edited">
            <span className="edit-label">✎ Edited</span>
            {edited.slice(0, 4).map((f) => <span key={f} className="file-chip" title={f}>{fileName(f)}</span>)}
            {edited.length > 4 && <span className="muted">+{edited.length - 4}</span>}
          </span>
        )}
        {text && <span className="activity-summary">{text}</span>}
        {blocked > 0 && <span className="blocked-count" title="Refused by the agent's permission level or failed">{blocked} not allowed / failed</span>}
        {current && (
          <span className="activity-now">
            {LIVE_VERB[current.category]} <span className="mono">{fileName(shorten(current.arg, root)) || current.name}</span>…
          </span>
        )}
      </button>
      {isOpen && (
        <div className="steps">
          {steps.map((s) => <StepRow key={s.id} step={s} root={root} />)}
        </div>
      )}
    </div>
  );
}

function StepRow({ step, root }: { step: Step; root: string }) {
  const [open, setOpen] = useState(false);
  if (step.kind === 'thinking') {
    return (
      <div className="step thinking-step" onClick={() => setOpen((o) => !o)}>
        <span className="step-icon">✦</span>
        <span className={`step-arg ${open ? 'wrap' : ''}`} dir="auto">{step.arg}</span>
      </div>
    );
  }
  const arg = shorten(step.arg, root);
  const result = step.result ? shorten(step.result, root).trim() : '';
  return (
    <div className={`step ${step.error ? 'err' : ''}`}>
      <div className="step-head" onClick={() => result && setOpen((o) => !o)}>
        <span className={`step-icon ${step.category}`}>{ICON[step.category]}</span>
        <span className="step-verb">{step.category === 'other' ? step.name : VERB[step.category]}</span>
        <span className="step-arg mono">{arg}</span>
        {step.error && <span className="step-flag">{/permission|approval|don't ask/i.test(result) ? 'not allowed' : 'failed'}</span>}
        {result && <span className="step-more">{open ? '▾' : '▸'}</span>}
      </div>
      {open && <pre className="step-result">{result}</pre>}
    </div>
  );
}
