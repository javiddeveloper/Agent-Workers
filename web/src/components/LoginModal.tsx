import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { onWs, wsSend, type AgentView } from '../api.ts';

const HINT: Record<string, string> = {
  claude: 'Run /login if it does not ask you to sign in. Close this window when you see the prompt.',
  gemini: 'Pick “Sign in with Google” (or paste an API key) and finish in your browser.',
  antigravity: 'Follow the sign-in steps; your browser opens to finish.',
  custom: '',
};

/** A real terminal running the agent's CLI interactively, only for signing in to its account. */
export function LoginModal({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState<number | null>(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0c0e12', foreground: '#d7dbe2' },
    });
    // Mode queries (DECRQM, e.g. ESC[?2026$p, sent by Antigravity at startup) hit an esbuild
    // minification bug in xterm's own handler that throws and leaves the terminal blank.
    // Answer them here instead: "not recognized" is a valid reply for any mode.
    for (const prefix of ['?', '']) {
      term.parser.registerCsiHandler({ prefix, intermediates: '$', final: 'p' }, (params) => {
        wsSend({ t: 'login-in', data: `\x1b[${prefix}${params[0] ?? 0};0$y` });
        return true;
      });
    }
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current!);
    fit.fit();
    term.focus();
    wsSend({ t: 'login-start', agentId: agent.id, cols: term.cols, rows: term.rows });
    const offWs = onWs((msg) => {
      if (msg.t === 'login-out') term.write(msg.data);
      if (msg.t === 'login-exit') setExited(msg.code);
      // Without this a failed start just leaves an empty black terminal.
      if (msg.t === 'login-error' || msg.t === 'error') term.write(`\r\n\x1b[31m${msg.error}\x1b[0m\r\n`);
    });
    const offData = term.onData((data) => wsSend({ t: 'login-in', data }));
    const offResize = term.onResize(({ cols, rows }) => wsSend({ t: 'login-resize', cols, rows }));
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(box.current!);
    return () => {
      wsSend({ t: 'login-stop' });
      offWs(); offData.dispose(); offResize.dispose(); ro.disconnect(); term.dispose();
    };
  }, [agent.id]);

  return (
    <div className="modal-backdrop">
      <div className="modal wide">
        <div className="modal-head">
          <h2>Sign in · {agent.name} <span className="muted">({agent.account})</span></h2>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <p className="muted pad-x">{HINT[agent.provider]}</p>
        <div className="login-term" ref={box} />
        <div className="modal-foot">
          {exited !== null && <span className="muted">Process exited ({exited}).</span>}
          <div className="spacer" />
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
