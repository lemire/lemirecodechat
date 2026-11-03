import { useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react';
import { useReview } from '../context/ReviewContext';

// The editor pulls in CodeMirror: load it only when the reviewer chooses to edit
const MarkdownEditor = lazy(() => import('./MarkdownEditor'));

const SAVE_DELAY = 400;

/** Dispatched on window before the review is submitted, so pending edits go first. */
export const FLUSH_EVENT = 'lemirecodechat:flush-pr-message';

/**
 * The PR message the agent proposed, shown above the diff. The reviewer may edit it;
 * edits are saved on the server as they type, so a reload or closed tab keeps them.
 */
export function PrMessagePanel() {
  const { state, send } = useReview();
  const original = state.session?.prMessage;
  const saved = state.session?.prMessageEdit ?? original ?? '';
  const edited = state.session?.prMessageEdit !== undefined;

  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current !== null) {
      send({ type: 'set_pr_message', data: { text: pending.current } });
      pending.current = null;
    }
  }, [send]);

  const onChange = useCallback((text: string) => {
    pending.current = text;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY);
  }, [flush]);

  const done = useCallback(() => {
    flush();
    setEditing(false);
  }, [flush]);

  // Never drop the last keystrokes: flush on unmount and right before a submit
  useEffect(() => {
    window.addEventListener(FLUSH_EVENT, flush);
    return () => {
      window.removeEventListener(FLUSH_EVENT, flush);
      flush();
    };
  }, [flush]);

  if (original === undefined) return null;

  return (
    <div className="mb-4 rounded-md" style={{ border: '1px solid var(--color-border-default)' }}>
      <div
        className="flex items-center gap-2 rounded-t-md px-3 py-2 text-sm"
        style={{ backgroundColor: 'var(--color-surface-bg)', borderBottom: collapsed ? 'none' : '1px solid var(--color-border-default)' }}
      >
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="font-semibold"
          style={{ color: 'var(--color-text-primary)' }}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▸' : '▾'} Pull request message
        </button>
        {edited && (
          <span
            className="rounded-full px-2 py-0.5 text-xs"
            style={{ border: '1px solid var(--color-warning)', color: 'var(--color-warning)' }}
            title="Your edited version will be sent to the agent"
          >
            edited
          </span>
        )}
        <span className="ml-auto flex gap-2">
          {edited && !editing && (
            <PanelButton onClick={() => send({ type: 'set_pr_message', data: { text: original } })} title="Discard your edits">
              Revert to agent's version
            </PanelButton>
          )}
          {editing ? (
            <PanelButton onClick={done} title="Done editing (Cmd/Ctrl+Enter or Esc)">Done</PanelButton>
          ) : (
            <PanelButton
              onClick={() => {
                setCollapsed(false);
                setEditing(true);
              }}
              title="Edit the PR message (Markdown)"
            >
              Edit message
            </PanelButton>
          )}
        </span>
      </div>
      {!collapsed &&
        (editing ? (
          <Suspense
            fallback={<div className="px-3 py-4 text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading editor…</div>}
          >
            <MarkdownEditor initial={saved} onChange={onChange} onDone={done} />
          </Suspense>
        ) : (
          <div
            className="pr-message-text px-3 py-2 font-mono text-sm"
            style={{ color: saved ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}
            onDoubleClick={() => setEditing(true)}
          >
            {saved || '(empty)'}
          </div>
        ))}
    </div>
  );
}

function PanelButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="rounded px-2 py-0.5 text-xs"
      style={{ border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)' }}
    >
      {children}
    </button>
  );
}
