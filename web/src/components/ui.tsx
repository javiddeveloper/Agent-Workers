import type { AgentView } from '../api.ts';

export const PROVIDER_SHORT: Record<string, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  custom: 'Custom',
};

export const ROLE_SHORT: Record<string, string> = {
  lead: 'Lead',
  worker: 'Worker',
  reviewer: 'Reviewer',
  custom: 'Custom',
};

export function Avatar({ agent, size = 28 }: { agent?: Pick<AgentView, 'name' | 'color'>; size?: number }) {
  const letter = (agent?.name ?? '?').trim().charAt(0).toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, background: agent?.color ?? '#555', fontSize: size * 0.45 }}>
      {letter}
    </span>
  );
}

export function StatusDot({ status }: { status: AgentView['status'] }) {
  return <span className={`status-dot ${status}`} title={status} />;
}

export function agentName(agents: AgentView[], id: string) {
  if (id === 'user') return 'You';
  if (id === 'system') return 'System';
  return agents.find((a) => a.id === id)?.name ?? id;
}

export function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function timeOf(ts: string) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Removes protocol tags (shown separately as task cards) from agent text. */
export function stripTags(text: string) {
  return text
    .replace(/<(task|message)\s+[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?blocked>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
