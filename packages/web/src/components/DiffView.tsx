import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode, type ReactElement } from 'react';
import { parseDiff, Diff, Hunk, Decoration, tokenize, markEdits, expandFromRawCode, getCollapsedLinesCountBetween } from 'react-diff-view';
import { refractor } from 'refractor';
import tsx from 'refractor/tsx';
import jsx from 'refractor/jsx';
import 'react-diff-view/style/index.css';
import { useReview } from '../context/ReviewContext';
import { FileHeader } from './FileHeader';
import { CommentWidget } from './CommentWidget';
import { CommentForm } from './CommentForm';
import { SuggestionEditor } from './SuggestionEditor';
import { buildChangeKeyMap } from '../utils/changeKeyMapping';
import { useGutterDrag } from '../hooks/useGutterDrag';
import { detectLanguage } from '../utils/languageDetect';
import type { Comment } from '../types';

// Register languages not in refractor's common bundle
refractor.register(tsx);
refractor.register(jsx);

// Adapter: refractor v5 returns { type: 'root', children: [...] } from highlight(),
// but react-diff-view v3 expects highlight() to return just the children array.
const refractorAdapter = {
  highlight: (code: string, language: string) => refractor.highlight(code, language).children,
  registered: (lang: string) => refractor.registered(lang),
};

/** Number of lines to expand per click */
const EXPAND_LINES = 20;

interface DiffViewProps {
  activeFile: string | null;
}

export type InteractionMode = 'comment' | 'edit';

/** Above this many changed lines, skip syntax highlighting to keep the page responsive. */
const MAX_HIGHLIGHT_CHANGES = 5000;

const WRAP_STORAGE_KEY = 'lemirecodechat-wrap';

function loadWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function DiffView({ activeFile }: DiffViewProps) {
  const { state } = useReview();
  const [viewType, setViewType] = useState<'unified' | 'split'>('unified');
  const [mode, setMode] = useState<InteractionMode>('comment');
  const [wrap, setWrap] = useState(loadWrap);
  const [showResolved, setShowResolved] = useState(true);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const parsedByPath = useMemo(() => {
    const map = new Map<string, ParsedFile>();
    if (!state.session) return map;
    for (const file of parseDiff(state.session.diff, { nearbySequences: 'zip' })) {
      map.set(diffFilePath(file), file);
    }
    return map;
  }, [state.session?.diff]);

  // "e" toggles edit mode, unless typing somewhere
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'e' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"], .cm-editor')) return;
      setMode((m) => (m === 'edit' ? 'comment' : 'edit'));
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function toggleWrap() {
    setWrap((w) => {
      try {
        localStorage.setItem(WRAP_STORAGE_KEY, w ? 'off' : 'on');
      } catch { /* not persisted */ }
      return !w;
    });
  }

  if (!state.session) return null;

  const resolvedCount = state.session.comments.filter((c) => c.resolved).length;
  const skipped = state.session.skipped ?? [];

  return (
    <div
      className={`flex-1 overflow-y-auto px-6 py-4${mode === 'edit' ? ' edit-mode' : ''}${wrap ? '' : ' diff-nowrap'}`}
      style={{ backgroundColor: 'var(--color-page-bg)' }}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SegmentedControl
          value={viewType}
          onChange={setViewType}
          options={[
            { value: 'unified', label: 'Unified' },
            { value: 'split', label: 'Split' },
          ]}
        />
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={[
            { value: 'comment', label: 'Comment', title: 'Click a line number to comment' },
            { value: 'edit', label: 'Edit', title: 'Click a line number to edit the code and suggest a change (shortcut: e)' },
          ]}
          activeColor={mode === 'edit' ? 'var(--color-warning)' : undefined}
        />
        <ToggleButton active={wrap} onClick={toggleWrap} title="Wrap long lines">
          Wrap lines
        </ToggleButton>
        {resolvedCount > 0 && (
          <ToggleButton active={showResolved} onClick={() => setShowResolved((v) => !v)} title="Show resolved comments">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
            </svg>
            {resolvedCount} resolved
          </ToggleButton>
        )}
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {mode === 'edit'
            ? 'Click or drag line numbers to edit code · Alt-click to comment instead'
            : 'Click or drag line numbers to comment · Alt-click to edit code'}
        </span>
      </div>

      {state.session.files.map((summary) => {
        const filePath = summary.path;
        const fileComments = state.session!.comments.filter((c) => c.filePath === filePath);
        const isCollapsed = collapsedFiles.has(filePath);

        let body: ReactNode = null;
        if (!isCollapsed) {
          if (summary.large) {
            const loaded = state.largeDiffs[filePath];
            const parsed = typeof loaded === 'string' ? parseDiff(loaded, { nearbySequences: 'zip' })[0] : undefined;
            body = parsed ? (
              <FileDiffSection
                file={parsed}
                filePath={filePath}
                viewType={viewType}
                mode={mode}
                comments={fileComments}
                showResolved={showResolved}
              />
            ) : (
              <LargeDiffPlaceholder
                filePath={filePath}
                additions={summary.additions}
                deletions={summary.deletions}
                commentCount={fileComments.length}
                loading={loaded === 'loading'}
              />
            );
          } else {
            const parsed = parsedByPath.get(filePath);
            body = parsed ? (
              <FileDiffSection
                file={parsed}
                filePath={filePath}
                viewType={viewType}
                mode={mode}
                comments={fileComments}
                showResolved={showResolved}
              />
            ) : (
              <EmptyFileBody>No changes to display</EmptyFileBody>
            );
          }
        }

        return (
          <div key={filePath} id={`file-${encodeURIComponent(filePath)}`} className="mb-4">
            <FileHeader
              file={summary}
              commentCount={fileComments.length}
              isCollapsed={isCollapsed}
              isActive={activeFile === filePath}
              onToggle={() => {
                setCollapsedFiles((prev) => {
                  const next = new Set(prev);
                  if (next.has(filePath)) next.delete(filePath);
                  else next.add(filePath);
                  return next;
                });
              }}
            />
            {body}
          </div>
        );
      })}
      {state.session.files.length > 0 && collapsedFiles.size >= state.session.files.length && (
        <div className="mt-4 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
          All files collapsed. Click a file header to expand.
        </div>
      )}
      {skipped.length > 0 && (
        <details className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <summary className="cursor-pointer">
            {skipped.length} binary file{skipped.length !== 1 ? 's' : ''} not shown
          </summary>
          <ul className="mt-1 pl-4 font-mono">
            {skipped.map((f) => (
              <li key={f.path}>{f.path}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function diffFilePath(file: ParsedFile): string {
  return file.newPath && file.newPath !== '/dev/null' ? file.newPath : file.oldPath || '';
}

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  activeColor,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; title?: string }[];
  activeColor?: string;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md" style={{ border: '1px solid var(--color-border-default)' }}>
      {options.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          title={opt.title}
          className="px-3 py-1 text-xs font-medium"
          style={{
            backgroundColor: value === opt.value ? 'var(--color-elevated-bg)' : 'transparent',
            color: value === opt.value ? (activeColor ?? 'var(--color-text-primary)') : 'var(--color-text-secondary)',
            ...(i > 0 ? { borderLeft: '1px solid var(--color-border-default)' } : {}),
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ToggleButton({ active, onClick, title, children }: { active: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium"
      style={{
        border: '1px solid var(--color-border-default)',
        color: active ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
        backgroundColor: active ? 'var(--color-elevated-bg)' : 'transparent',
      }}
    >
      {children}
    </button>
  );
}

function EmptyFileBody({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-b-md p-4 text-sm"
      style={{
        backgroundColor: 'var(--color-surface-bg)',
        color: 'var(--color-text-muted)',
        border: '1px solid var(--color-border-default)',
        borderTop: 'none',
      }}
    >
      {children}
    </div>
  );
}

function LargeDiffPlaceholder({
  filePath,
  additions,
  deletions,
  commentCount,
  loading,
}: {
  filePath: string;
  additions: number;
  deletions: number;
  commentCount: number;
  loading: boolean;
}) {
  const { requestFileDiff } = useReview();
  return (
    <EmptyFileBody>
      <div className="flex flex-wrap items-center gap-3">
        <span>
          Large diff not shown (
          <span style={{ color: 'var(--color-success)' }}>+{additions}</span>{' '}
          <span style={{ color: 'var(--color-danger)' }}>-{deletions}</span>)
          {commentCount > 0 && ` · ${commentCount} comment${commentCount !== 1 ? 's' : ''}`}
        </span>
        <button
          onClick={() => requestFileDiff(filePath)}
          disabled={loading}
          className="rounded-md px-3 py-1 text-xs font-medium disabled:opacity-50"
          style={{ border: '1px solid var(--color-border-default)', color: 'var(--color-link)' }}
        >
          {loading ? 'Loading…' : 'Load diff'}
        </button>
      </div>
    </EmptyFileBody>
  );
}

type ParsedFile = ReturnType<typeof parseDiff>[number];

interface FileDiffSectionProps {
  file: ParsedFile;
  filePath: string;
  viewType: 'unified' | 'split';
  mode: InteractionMode;
  comments: Comment[];
  showResolved: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHunk = any;

function FileDiffSection({ file, filePath, viewType, mode, comments, showResolved }: FileDiffSectionProps) {
  const { state, startDraft, discardDraft, requestFileContent } = useReview();
  const draft = state.activeDraft?.filePath === filePath ? state.activeDraft : null;
  const fileContent = state.fileContents[filePath];

  // Track expanded hunks independently from the parsed diff
  const [expandedHunks, setExpandedHunks] = useState<AnyHunk[] | null>(null);
  const pendingExpand = useRef<{ start: number; end: number } | null>(null);

  // Use the old file content as the source for expansion (old line numbers are the reference)
  const rawSource = fileContent?.oldContent ?? fileContent?.newContent ?? null;

  const hunks = expandedHunks ?? file.hunks;

  const expand = useCallback(
    (start: number, end: number) => {
      if (!rawSource) {
        // Request file content; queue the expand for when it arrives
        pendingExpand.current = { start, end };
        requestFileContent(filePath);
        return;
      }
      setExpandedHunks((prev) => {
        const current = prev ?? file.hunks;
        return expandFromRawCode(current, rawSource, start, end);
      });
    },
    [rawSource, file.hunks, filePath, requestFileContent],
  );

  // Apply pending expansion when file content arrives
  useEffect(() => {
    if (rawSource && pendingExpand.current) {
      const { start, end } = pendingExpand.current;
      pendingExpand.current = null;
      setExpandedHunks((prev) => {
        const current = prev ?? file.hunks;
        return expandFromRawCode(current, rawSource, start, end);
      });
    }
  }, [rawSource, file.hunks]);

  const tokens = useMemo(() => {
    const language = detectLanguage(filePath);
    if (!language || hunks.length === 0) return undefined;
    const changeCount = hunks.reduce((n: number, h: AnyHunk) => n + h.changes.length, 0);
    if (changeCount > MAX_HIGHLIGHT_CHANGES) return undefined;
    if (!refractorAdapter.registered(language)) return undefined;
    try {
      return tokenize(hunks, {
        highlight: true,
        refractor: refractorAdapter,
        language,
        enhancers: [markEdits(hunks)],
      });
    } catch {
      return undefined;
    }
  }, [hunks, filePath]);

  const changeKeyMap = useMemo(() => buildChangeKeyMap(hunks), [hunks]);

  const handleDragSelect = useCallback(
    (side: 'old' | 'new', startLine: number, endLine: number, altKey: boolean) => {
      const wanted: InteractionMode = altKey ? (mode === 'edit' ? 'comment' : 'edit') : mode;
      // Deleted lines no longer exist in the file, so they can only be commented on
      const kind = wanted === 'edit' && side === 'new' ? 'suggestion' : 'comment';
      startDraft({ kind, filePath, line: startLine, side, ...(endLine !== startLine ? { endLine } : {}) });
    },
    [filePath, mode, startDraft],
  );

  const { gutterEvents, selectedChanges } = useGutterDrag({
    hunks,
    onSelect: handleDragSelect,
  });

  // For range comments, anchor the widget at endLine so it appears after the last line of the range
  const draftAnchorLine = draft ? (draft.endLine ?? draft.line) : null;
  const draftChangeKey = draft && draftAnchorLine
    ? (changeKeyMap.get(`${draft.side}:${draftAnchorLine}`) ?? null)
    : null;

  const widgets = useMemo(() => {
    const w: Record<string, ReactNode> = {};

    const visibleComments = showResolved ? comments : comments.filter((c) => !c.resolved);

    const commentsByKey = new Map<string, Comment[]>();
    for (const comment of visibleComments) {
      // Anchor at endLine for range comments so the widget sits after the last line
      const anchorLine = comment.endLine ?? comment.line;
      const changeKey = changeKeyMap.get(`${comment.side}:${anchorLine}`) ?? null;
      if (changeKey) {
        const existing = commentsByKey.get(changeKey) ?? [];
        existing.push(comment);
        commentsByKey.set(changeKey, existing);
      }
    }

    for (const [changeKey, keyComments] of commentsByKey) {
      w[changeKey] = (
        <CommentWidget
          comments={keyComments}
          onReply={() => {
            const c = keyComments[0];
            startDraft({ kind: 'comment', filePath, line: c.line, side: c.side, endLine: c.endLine });
          }}
        />
      );
    }

    if (draftChangeKey) {
      const existing = w[draftChangeKey];
      w[draftChangeKey] = (
        <>
          {existing}
          {draft!.kind === 'suggestion' ? (
            <SuggestionEditor draft={draft!} />
          ) : (
            <CommentForm
              filePath={filePath}
              line={draft!.line}
              side={draft!.side}
              endLine={draft!.endLine}
              onCancel={discardDraft}
            />
          )}
        </>
      );
    }

    return w;
  }, [comments, draftChangeKey, draft, filePath, changeKeyMap, showResolved, startDraft, discardDraft]);

  // Reset expanded hunks when the underlying diff changes
  const [prevFileHunks, setPrevFileHunks] = useState(file.hunks);
  if (file.hunks !== prevFileHunks) {
    setPrevFileHunks(file.hunks);
    setExpandedHunks(null);
  }

  if (file.hunks.length === 0) {
    return (
      <div
        className="rounded-b-md p-4 text-sm"
        style={{
          backgroundColor: 'var(--color-surface-bg)',
          color: 'var(--color-text-muted)',
          border: '1px solid var(--color-border-default)',
          borderTop: 'none',
        }}
      >
        No changes to display
      </div>
    );
  }

  // Determine total lines for the file (from raw source or last hunk)
  const totalLines = rawSource
    ? rawSource.split('\n').length
    : null;

  const renderHunks = (hunkList: AnyHunk[]) => {
    const elements: ReactElement[] = [];

    for (let i = 0; i < hunkList.length; i++) {
      const hunk = hunkList[i];
      const prevHunk: AnyHunk | null = i > 0 ? hunkList[i - 1] : null;

      // Collapsed lines before this hunk
      const collapsedCount = getCollapsedLinesCountBetween(prevHunk, hunk);

      if (collapsedCount > 0) {
        elements.push(
          <ExpandButton
            key={`expand-${i}`}
            collapsedCount={collapsedCount}
            isFirst={i === 0}
            isLast={false}
            onExpandUp={() => {
              const end = hunk.oldStart;
              const start = Math.max(prevHunk ? prevHunk.oldStart + prevHunk.oldLines : 1, end - EXPAND_LINES);
              expand(start, end);
            }}
            onExpandDown={() => {
              const start = prevHunk ? prevHunk.oldStart + prevHunk.oldLines : 1;
              const end = Math.min(hunk.oldStart, start + EXPAND_LINES);
              expand(start, end);
            }}
            onExpandAll={() => {
              const start = prevHunk ? prevHunk.oldStart + prevHunk.oldLines : 1;
              const end = hunk.oldStart;
              expand(start, end);
            }}
          />,
        );
      }

      elements.push(<Hunk key={hunk.content} hunk={hunk} />);
    }

    // Collapsed lines after the last hunk
    if (totalLines && hunkList.length > 0) {
      const lastHunk = hunkList[hunkList.length - 1];
      const lastOldEnd = lastHunk.oldStart + lastHunk.oldLines;
      const trailingLines = totalLines - lastOldEnd + 1;

      if (trailingLines > 0) {
        elements.push(
          <ExpandButton
            key="expand-tail"
            collapsedCount={trailingLines}
            isFirst={false}
            isLast={true}
            onExpandUp={() => {
              const start = lastOldEnd;
              const end = Math.min(totalLines + 1, start + EXPAND_LINES);
              expand(start, end);
            }}
            onExpandDown={() => {
              expand(lastOldEnd, totalLines + 1);
            }}
            onExpandAll={() => {
              expand(lastOldEnd, totalLines + 1);
            }}
          />,
        );
      }
    }

    return elements;
  };

  return (
    <div
      className="overflow-x-auto rounded-b-md"
      style={{
        border: '1px solid var(--color-border-default)',
        borderTop: 'none',
      }}
    >
      <Diff
        viewType={viewType}
        diffType={file.type}
        hunks={hunks}
        widgets={widgets}
        tokens={tokens}
        gutterEvents={gutterEvents}
        selectedChanges={selectedChanges}
      >
        {renderHunks}
      </Diff>
    </div>
  );
}

interface ExpandButtonProps {
  collapsedCount: number;
  isFirst: boolean;
  isLast: boolean;
  onExpandUp: () => void;
  onExpandDown: () => void;
  onExpandAll: () => void;
}

function ExpandButton({ collapsedCount, isFirst, isLast, onExpandUp, onExpandDown, onExpandAll }: ExpandButtonProps) {
  const showDirectional = collapsedCount > EXPAND_LINES;

  const gutterContent = (
    <div className="expand-gutter">
      {showDirectional && !isFirst && (
        <button
          onClick={onExpandUp}
          className="expand-gutter-btn"
          title={`Show ${EXPAND_LINES} lines above`}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M12.78 6.22a.75.75 0 0 1-1.06 0L8 2.5 4.28 6.22a.75.75 0 0 1-1.06-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06Z" />
          </svg>
        </button>
      )}
      <button
        onClick={onExpandAll}
        className="expand-gutter-btn"
        title={`Expand all ${collapsedCount} hidden lines`}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 6.22a.75.75 0 0 1-1.06 0L8 2.5 4.28 6.22a.75.75 0 0 1-1.06-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06Zm-9.56 3.56a.75.75 0 0 1 1.06 0L8 13.5l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0l-4.25-4.25a.75.75 0 0 1 0-1.06Z" />
        </svg>
      </button>
      {showDirectional && !isLast && (
        <button
          onClick={onExpandDown}
          className="expand-gutter-btn"
          title={`Show ${EXPAND_LINES} lines below`}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.22 9.78a.75.75 0 0 1 1.06 0L8 13.5l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0l-4.25-4.25a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      )}
    </div>
  );

  const codeContent = (
    <span className="expand-text">{collapsedCount} hidden lines</span>
  );

  return (
    <Decoration>
      {gutterContent}
      {codeContent}
    </Decoration>
  );
}
