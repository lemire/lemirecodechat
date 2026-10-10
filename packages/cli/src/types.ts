export interface Session {
  id: string;
  repoPath: string;
  createdAt: string;
  updatedAt: string;
  status: 'pending' | 'approved' | 'changes_requested';
  /** Unified diff of the files whose diff is shown inline (excludes large and binary files). */
  diff: string;
  files: FileSummary[];
  /** Files left out of the review entirely (binary files). */
  skipped?: SkippedFile[];
  comments: Comment[];
  description?: string;
  /**
   * Ref the working tree is compared against when the review covers commits too
   * (e.g. "main" or "HEAD~2"). Absent: only uncommitted changes (against HEAD).
   */
  base?: string;
  /** Commit `base` resolved to when the review was opened. */
  baseCommit?: string;
}

export interface FileSummary {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  /** The diff is too large to show by default; the browser loads it on demand. */
  large?: boolean;
}

export interface SkippedFile {
  path: string;
  reason: 'binary';
}

/** A concrete code edit proposed by the reviewer. */
export interface Suggestion {
  /** Lines `line..endLine` of the working-tree file at the time the suggestion was made. */
  original: string;
  /** What the reviewer wants those lines replaced with. */
  replacement: string;
  /** Unified diff from `original` to `replacement`, with real file line numbers. */
  patch: string;
}

export interface Comment {
  id: string;
  /** 'suggestion' comments carry a proposed edit in `suggestion`. Absent means 'comment'. */
  kind?: 'comment' | 'suggestion';
  filePath: string;
  line: number;
  endLine?: number;
  side: 'old' | 'new';
  /** Free text; for suggestions this is an optional rationale and may be empty. */
  body: string;
  suggestion?: Suggestion;
  createdAt: string;
  resolved: boolean;
  agentReply?: string;
}

/**
 * Why a review round ended:
 * - 'submitted': the reviewer clicked Submit.
 * - 'timeout': the session timed out before the reviewer submitted.
 * - 'closed': every browser tab was closed without submitting.
 */
export type ReviewEndReason = 'submitted' | 'timeout' | 'closed';

export interface ReviewResult {
  sessionId: string;
  /** 'approved' only when the reviewer submitted with no unresolved comments. */
  status: 'pending' | 'approved' | 'changes_requested';
  /** Present when the result comes from a review round (absent for replies). */
  reason?: ReviewEndReason;
  comments: Comment[];
  /** The reviewer's overall message from the submit dialog. */
  summary?: string;
  /** Present when the review covered commits: the ref the working tree was compared against. */
  base?: string;
}

export interface ReviewServer {
  port: number;
  url: string;
  result: Promise<ReviewResult>;
}

// WebSocket protocol

export type ServerMessage =
  | { type: 'init'; data: Session }
  | { type: 'comment_added'; data: Comment }
  | { type: 'comment_edited'; data: Comment }
  | { type: 'comment_deleted'; data: { id: string } }
  | { type: 'diff_updated'; data: { diff: string; files: FileSummary[]; skipped: SkippedFile[] } }
  | { type: 'file_content'; data: { filePath: string; oldContent: string | null; newContent: string | null } }
  | { type: 'file_diff'; data: { filePath: string; diff: string } }
  | { type: 'error'; data: { message: string } }
  | { type: 'review_complete' };

export type ClientMessage =
  | {
      type: 'add_comment';
      data: {
        filePath: string;
        line: number;
        endLine?: number;
        side: 'old' | 'new';
        body: string;
        kind?: 'comment' | 'suggestion';
        replacement?: string;
      };
    }
  | { type: 'edit_comment'; data: { id: string; body: string; replacement?: string } }
  | { type: 'delete_comment'; data: { id: string } }
  | { type: 'submit_review'; data?: { summary?: string } }
  | { type: 'request_file_content'; data: { filePath: string } }
  | { type: 'request_file_diff'; data: { filePath: string } };
