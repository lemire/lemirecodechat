import { createContext, useContext, useReducer, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { Session, Comment, FileSummary, SkippedFile, ClientMessage, ServerMessage } from '../types';
import { useWebSocket } from '../hooks/useWebSocket';

export type DraftKind = 'comment' | 'suggestion';

export interface CommentDraft {
  kind: DraftKind;
  filePath: string;
  line: number;
  endLine?: number;
  side: 'old' | 'new';
  body: string;
  /** Suggestion text; undefined until the file content has arrived to seed it. */
  replacement?: string;
  /** Set when re-opening an existing suggestion for editing. */
  editingId?: string;
}

export interface FileContent {
  oldContent: string | null;
  newContent: string | null;
}

/** On-demand diff of a large file: the diff text once loaded, or 'loading'. */
export type LargeDiff = string | 'loading';

interface ReviewState {
  session: Session | null;
  isConnected: boolean;
  isSubmitted: boolean;
  activeDraft: CommentDraft | null;
  fileContents: Record<string, FileContent>;
  largeDiffs: Record<string, LargeDiff>;
  error: string | null;
}

type ReviewAction =
  | { type: 'INIT'; session: Session }
  | { type: 'COMMENT_ADDED'; comment: Comment }
  | { type: 'COMMENT_EDITED'; comment: Comment }
  | { type: 'COMMENT_DELETED'; id: string }
  | { type: 'DIFF_UPDATED'; diff: string; files: FileSummary[]; skipped: SkippedFile[] }
  | { type: 'FILE_CONTENT'; filePath: string; oldContent: string | null; newContent: string | null }
  | { type: 'FILE_DIFF'; filePath: string; diff: string }
  | { type: 'LARGE_DIFF_LOADING'; filePath: string }
  | { type: 'ERROR'; message: string | null }
  | { type: 'REVIEW_COMPLETE' }
  | { type: 'CONNECTION_STATUS'; connected: boolean }
  | { type: 'START_DRAFT'; draft: Omit<CommentDraft, 'body'> & { body?: string } }
  | { type: 'UPDATE_DRAFT'; body?: string; replacement?: string }
  | { type: 'RESIZE_DRAFT'; line: number; endLine: number; replacement: string }
  | { type: 'DISCARD_DRAFT' };

const initialState: ReviewState = {
  session: null,
  isConnected: false,
  isSubmitted: false,
  activeDraft: null,
  fileContents: {},
  largeDiffs: {},
  error: null,
};

function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'INIT':
      return { ...state, session: action.session };
    case 'COMMENT_ADDED':
      if (!state.session) return state;
      return {
        ...state,
        activeDraft: null,
        session: {
          ...state.session,
          comments: [...state.session.comments, action.comment],
        },
      };
    case 'COMMENT_EDITED':
      if (!state.session) return state;
      return {
        ...state,
        activeDraft: state.activeDraft?.editingId === action.comment.id ? null : state.activeDraft,
        session: {
          ...state.session,
          comments: state.session.comments.map((c) => (c.id === action.comment.id ? action.comment : c)),
        },
      };
    case 'COMMENT_DELETED':
      if (!state.session) return state;
      return {
        ...state,
        session: {
          ...state.session,
          comments: state.session.comments.filter((c) => c.id !== action.id),
        },
      };
    case 'DIFF_UPDATED':
      if (!state.session) return state;
      return {
        ...state,
        // Cached contents may be stale now; loaded large diffs are re-requested by the provider
        fileContents: {},
        session: {
          ...state.session,
          diff: action.diff,
          files: action.files,
          skipped: action.skipped,
        },
      };
    case 'FILE_CONTENT':
      return {
        ...state,
        fileContents: {
          ...state.fileContents,
          [action.filePath]: { oldContent: action.oldContent, newContent: action.newContent },
        },
      };
    case 'FILE_DIFF':
      return { ...state, largeDiffs: { ...state.largeDiffs, [action.filePath]: action.diff } };
    case 'LARGE_DIFF_LOADING':
      return { ...state, largeDiffs: { ...state.largeDiffs, [action.filePath]: 'loading' } };
    case 'ERROR': {
      if (action.message === null) return { ...state, error: null };
      // A failed large-diff load should not leave the file stuck in 'loading'
      const largeDiffs = Object.fromEntries(
        Object.entries(state.largeDiffs).filter(([path, d]) => !(d === 'loading' && action.message!.includes(path))),
      );
      return { ...state, error: action.message, largeDiffs };
    }
    case 'REVIEW_COMPLETE':
      return { ...state, isSubmitted: true };
    case 'CONNECTION_STATUS':
      return { ...state, isConnected: action.connected };
    case 'START_DRAFT':
      return { ...state, activeDraft: { body: '', ...action.draft } };
    case 'UPDATE_DRAFT':
      if (!state.activeDraft) return state;
      return {
        ...state,
        activeDraft: {
          ...state.activeDraft,
          ...(action.body !== undefined ? { body: action.body } : {}),
          ...(action.replacement !== undefined ? { replacement: action.replacement } : {}),
        },
      };
    case 'RESIZE_DRAFT':
      if (!state.activeDraft) return state;
      return {
        ...state,
        activeDraft: {
          ...state.activeDraft,
          line: action.line,
          endLine: action.endLine !== action.line ? action.endLine : undefined,
          replacement: action.replacement,
        },
      };
    case 'DISCARD_DRAFT':
      return { ...state, activeDraft: null };
    default:
      return state;
  }
}

interface ReviewContextValue {
  state: ReviewState;
  send: (msg: ClientMessage) => void;
  startDraft: (draft: Omit<CommentDraft, 'body'> & { body?: string }) => void;
  updateDraft: (update: { body?: string; replacement?: string }) => void;
  resizeDraft: (line: number, endLine: number, replacement: string) => void;
  discardDraft: () => void;
  requestFileContent: (filePath: string) => void;
  requestFileDiff: (filePath: string) => void;
  clearError: () => void;
}

const ReviewContext = createContext<ReviewContextValue | null>(null);

export function ReviewProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reviewReducer, initialState);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'init':
        dispatch({ type: 'INIT', session: msg.data });
        if (window.location.pathname !== `/${msg.data.id}`) {
          history.replaceState(null, '', `/${msg.data.id}`);
        }
        break;
      case 'comment_added':
        dispatch({ type: 'COMMENT_ADDED', comment: msg.data });
        break;
      case 'comment_edited':
        dispatch({ type: 'COMMENT_EDITED', comment: msg.data });
        break;
      case 'comment_deleted':
        dispatch({ type: 'COMMENT_DELETED', id: msg.data.id });
        break;
      case 'diff_updated':
        dispatch({ type: 'DIFF_UPDATED', diff: msg.data.diff, files: msg.data.files, skipped: msg.data.skipped });
        break;
      case 'file_content':
        dispatch({ type: 'FILE_CONTENT', filePath: msg.data.filePath, oldContent: msg.data.oldContent, newContent: msg.data.newContent });
        break;
      case 'file_diff':
        dispatch({ type: 'FILE_DIFF', filePath: msg.data.filePath, diff: msg.data.diff });
        break;
      case 'error':
        dispatch({ type: 'ERROR', message: msg.data.message });
        break;
      case 'review_complete':
        dispatch({ type: 'REVIEW_COMPLETE' });
        setTimeout(() => window.close(), 500);
        break;
    }
  }, []);

  const { send, status } = useWebSocket(handleMessage);

  useEffect(() => {
    dispatch({ type: 'CONNECTION_STATUS', connected: status === 'connected' });
  }, [status]);

  const startDraft = useCallback((draft: Omit<CommentDraft, 'body'> & { body?: string }) => {
    dispatch({ type: 'START_DRAFT', draft });
  }, []);

  const updateDraft = useCallback((update: { body?: string; replacement?: string }) => {
    dispatch({ type: 'UPDATE_DRAFT', ...update });
  }, []);

  const resizeDraft = useCallback((line: number, endLine: number, replacement: string) => {
    dispatch({ type: 'RESIZE_DRAFT', line, endLine, replacement });
  }, []);

  const discardDraft = useCallback(() => {
    dispatch({ type: 'DISCARD_DRAFT' });
  }, []);

  const requestFileContent = useCallback((filePath: string) => {
    send({ type: 'request_file_content', data: { filePath } });
  }, [send]);

  const requestFileDiff = useCallback((filePath: string) => {
    dispatch({ type: 'LARGE_DIFF_LOADING', filePath });
    send({ type: 'request_file_diff', data: { filePath } });
  }, [send]);

  const clearError = useCallback(() => dispatch({ type: 'ERROR', message: null }), []);

  // When the working tree changes, refresh the large diffs the user already opened
  const largeDiffsRef = useRef(state.largeDiffs);
  largeDiffsRef.current = state.largeDiffs;
  const files = state.session?.files;
  const firstFiles = useRef(true);
  useEffect(() => {
    if (!files) return;
    if (firstFiles.current) {
      firstFiles.current = false;
      return;
    }
    for (const path of Object.keys(largeDiffsRef.current)) {
      if (files.some((f) => f.path === path && f.large)) requestFileDiff(path);
    }
  }, [files, requestFileDiff]);

  return (
    <ReviewContext.Provider
      value={{ state, send, startDraft, updateDraft, resizeDraft, discardDraft, requestFileContent, requestFileDiff, clearError }}
    >
      {children}
    </ReviewContext.Provider>
  );
}

export function useReview() {
  const ctx = useContext(ReviewContext);
  if (!ctx) throw new Error('useReview must be used within ReviewProvider');
  return ctx;
}
