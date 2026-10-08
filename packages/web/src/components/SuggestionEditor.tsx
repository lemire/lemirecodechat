import { useEffect, useMemo, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { useReview, type CommentDraft } from '../context/ReviewContext';
import { editorTheme } from '../utils/editorTheme';

/** How many lines the "more above/below" buttons pull into the suggestion. */
const EXTEND_LINES = 3;

const isMac = /(Mac|iPhone|iPad)/.test(navigator.userAgent);

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface SuggestionEditorProps {
  draft: CommentDraft;
}

/**
 * Inline code editor for proposing a concrete change to lines draft.line..draft.endLine
 * of the new file. The result goes to the agent as a 'suggestion' comment.
 */
export function SuggestionEditor({ draft }: SuggestionEditorProps) {
  const { state, send, updateDraft, resizeDraft, discardDraft, requestFileContent } = useReview();
  const content = state.fileContents[draft.filePath]?.newContent;
  const endLine = draft.endLine ?? draft.line;

  const fileLines = useMemo(() => (typeof content === 'string' ? splitLines(content) : null), [content]);
  const original = fileLines ? fileLines.slice(draft.line - 1, endLine).join('\n') : null;

  // Fetch the file, then seed the editor with the selected lines
  useEffect(() => {
    if (content === undefined) requestFileContent(draft.filePath);
  }, [content, draft.filePath, requestFileContent]);

  useEffect(() => {
    if (draft.replacement === undefined && original !== null) updateDraft({ replacement: original });
  }, [draft.replacement, original, updateDraft]);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartments = useRef({ language: new Compartment(), gutter: new Compartment() });

  // Latest values for the CodeMirror keymap closures
  const submitRef = useRef<() => void>(() => {});
  const cancelRef = useRef(discardDraft);
  cancelRef.current = discardDraft;

  const ready = draft.replacement !== undefined;

  useEffect(() => {
    if (!ready || !hostRef.current) return;
    const { language, gutter } = compartments.current;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: draft.replacement,
        extensions: [
          gutter.of(lineNumbers({ formatNumber: (n) => String(n + draft.line - 1) })),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          EditorView.lineWrapping,
          editorTheme,
          keymap.of([
            { key: 'Mod-Enter', run: () => (submitRef.current(), true) },
            { key: 'Escape', run: () => (cancelRef.current(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          language.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) updateDraft({ replacement: update.state.doc.toString() });
          }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();

    const description = LanguageDescription.matchFilename(languages, draft.filePath);
    description?.load().then((support) => {
      if (viewRef.current === view) view.dispatch({ effects: language.reconfigure(support) });
    }).catch(() => { /* plain text */ });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is created once per draft; later changes flow through the effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, draft.filePath, draft.editingId]);

  // Text replaced from outside the editor (range extended, reset): sync the document
  useEffect(() => {
    const view = viewRef.current;
    if (!view || draft.replacement === undefined) return;
    if (view.state.doc.toString() !== draft.replacement) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft.replacement } });
    }
  }, [draft.replacement]);

  // Line numbers follow the real file lines
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.gutter.reconfigure(lineNumbers({ formatNumber: (n) => String(n + draft.line - 1) })),
    });
  }, [draft.line]);

  const isEditingExisting = draft.editingId !== undefined;
  const existing = isEditingExisting ? state.session?.comments.find((c) => c.id === draft.editingId) : undefined;
  const baseline = existing?.suggestion?.original ?? original;
  const unchanged = draft.replacement === undefined || draft.replacement === baseline;

  function submit() {
    if (draft.replacement === undefined || unchanged) return;
    if (isEditingExisting) {
      send({ type: 'edit_comment', data: { id: draft.editingId!, body: draft.body, replacement: draft.replacement } });
    } else {
      send({
        type: 'add_comment',
        data: {
          kind: 'suggestion',
          filePath: draft.filePath,
          line: draft.line,
          ...(endLine !== draft.line ? { endLine } : {}),
          side: 'new',
          body: draft.body,
          replacement: draft.replacement,
        },
      });
    }
  }
  submitRef.current = submit;

  function extend(direction: 'up' | 'down') {
    if (!fileLines || draft.replacement === undefined) return;
    if (direction === 'up') {
      const newStart = Math.max(1, draft.line - EXTEND_LINES);
      const added = fileLines.slice(newStart - 1, draft.line - 1).join('\n');
      resizeDraft(newStart, endLine, added + '\n' + draft.replacement);
    } else {
      const newEnd = Math.min(fileLines.length, endLine + EXTEND_LINES);
      const added = fileLines.slice(endLine, newEnd).join('\n');
      resizeDraft(draft.line, newEnd, draft.replacement + '\n' + added);
    }
  }

  const canResize = !isEditingExisting && fileLines !== null;

  return (
    <div
      className="suggestion-editor my-2 rounded-md p-3"
      style={{ backgroundColor: 'var(--color-page-bg)', border: '1px solid var(--color-warning)' }}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold" style={{ color: 'var(--color-warning)' }}>
          {isEditingExisting ? 'Edit suggested change' : 'Suggest a change'}
        </span>
        <span style={{ color: 'var(--color-text-muted)' }}>
          {endLine !== draft.line ? `lines ${draft.line}–${endLine}` : `line ${draft.line}`}
        </span>
        {canResize && (
          <span className="ml-auto flex gap-1">
            <SmallButton onClick={() => extend('up')} disabled={draft.line <= 1} title={`Include ${EXTEND_LINES} lines above`}>
              ↑ more above
            </SmallButton>
            <SmallButton
              onClick={() => extend('down')}
              disabled={endLine >= fileLines!.length}
              title={`Include ${EXTEND_LINES} lines below`}
            >
              ↓ more below
            </SmallButton>
          </span>
        )}
      </div>

      {ready ? (
        <div ref={hostRef} />
      ) : (
        <div className="py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {content === null ? 'This file cannot be edited (deleted, binary or too large).' : 'Loading file…'}
        </div>
      )}

      <textarea
        value={draft.body}
        onChange={(e) => updateDraft({ body: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') discardDraft();
        }}
        placeholder="Why? (optional)"
        rows={2}
        className="mt-2 w-full resize-y rounded-md p-2 text-sm"
        style={{
          backgroundColor: 'var(--color-deep-bg)',
          color: 'var(--color-text-primary)',
          border: '1px solid var(--color-border-default)',
          outline: 'none',
        }}
      />

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={unchanged}
          className="rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          style={{ backgroundColor: 'var(--color-btn-green-bg)', color: 'var(--color-text-on-emphasis)', border: '1px solid var(--color-btn-border)' }}
        >
          {isEditingExisting ? 'Update suggestion' : 'Add suggestion'}
        </button>
        <button onClick={discardDraft} className="rounded-md px-3 py-1.5 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Cancel
        </button>
        {original !== null && !unchanged && !isEditingExisting && (
          <button
            onClick={() => updateDraft({ replacement: original })}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Reset
          </button>
        )}
        <span className="ml-auto text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {unchanged && ready ? 'Edit the code to suggest a change · ' : ''}
          {isMac ? 'Cmd' : 'Ctrl'}+Enter to submit · Esc to cancel
        </span>
      </div>
    </div>
  );
}

function SmallButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="rounded px-2 py-0.5 disabled:opacity-40"
      style={{ border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)' }}
    >
      {children}
    </button>
  );
}
