import { isGitRepo, getRepoRoot, collectChanges, resolveCommit, DEFAULT_LIMITS, type DiffLimits } from './git.js';
import {
  resolveSession,
  loadSession,
  saveSession,
  listSessionsByRepo,
  findSessionByRepo,
  applyReplies,
  type Reply,
  type SessionBase,
} from './session.js';
import { startReviewServer } from './server.js';
import { getWebDistPath } from './paths.js';
import type { ReviewResult, Session } from './types.js';
import open from 'open';

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export interface ReviewOptions {
  repoPath: string;
  sessionId?: string;
  description?: string;
  replies?: Reply[];
  /** Only record `replies` (see `recordReplies`); don't open a review. */
  skipReview?: boolean;
  /**
   * Also review committed work: compare the working tree against this ref
   * (e.g. "main", "HEAD~2") instead of HEAD.
   */
  base?: string;
  /** Force creation of a new session instead of resuming */
  newSession?: boolean;
  port?: number;
  /** Session timeout in milliseconds */
  timeout?: number;
  /** Whether to open the browser (default: true) */
  openBrowser?: boolean;
  /** Thresholds above which a file's diff is only shown on demand */
  limits?: Partial<DiffLimits>;
}

/**
 * Diff limits from options, falling back to LEMIRECODECHAT_MAX_LINES / LEMIRECODECHAT_MAX_BYTES /
 * LEMIRECODECHAT_MAX_TOTAL_BYTES, then defaults.
 */
export function resolveLimits(limits?: Partial<DiffLimits>): DiffLimits {
  const env = (name: string) => {
    const n = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    maxLines: limits?.maxLines ?? env('LEMIRECODECHAT_MAX_LINES') ?? DEFAULT_LIMITS.maxLines,
    maxBytes: limits?.maxBytes ?? env('LEMIRECODECHAT_MAX_BYTES') ?? DEFAULT_LIMITS.maxBytes,
    maxTotalBytes: limits?.maxTotalBytes ?? env('LEMIRECODECHAT_MAX_TOTAL_BYTES') ?? DEFAULT_LIMITS.maxTotalBytes,
  };
}

export type ReviewOutcome =
  | { kind: 'empty_diff'; message: string }
  | { kind: 'skipped'; result: ReviewResult }
  | { kind: 'reviewed'; result: ReviewResult; url: string };

async function canonicalRepo(repoPath: string): Promise<string> {
  if (!(await isGitRepo(repoPath))) {
    throw new WorkflowError(`Not a git repository: ${repoPath}`);
  }
  return getRepoRoot(repoPath);
}

/**
 * Record the agent's replies on the current session of a repository (or on `sessionId`)
 * without opening a review. Works even when nothing is left uncommitted.
 */
export async function recordReplies(repoPath: string, replies: Reply[], sessionId?: string): Promise<ReviewResult> {
  const canonicalPath = await canonicalRepo(repoPath);
  try {
    const session = sessionId ? await loadSession(sessionId) : await findSessionByRepo(canonicalPath);
    if (!session) throw new Error('No review session found for this repository.');
    applyReplies(session, replies);
    await saveSession(session);
    return { sessionId: session.id, status: session.status, comments: session.comments };
  } catch (err) {
    throw new WorkflowError((err as Error).message);
  }
}

export async function executeReview(options: ReviewOptions): Promise<ReviewOutcome> {
  if (options.skipReview) {
    const result = await recordReplies(options.repoPath, options.replies ?? [], options.sessionId);
    return { kind: 'skipped', result };
  }

  const canonicalPath = await canonicalRepo(options.repoPath);
  const limits = resolveLimits(options.limits);

  let base: SessionBase | undefined;
  if (options.base) {
    try {
      base = { ref: options.base, commit: await resolveCommit(canonicalPath, options.base) };
    } catch (err) {
      throw new WorkflowError((err as Error).message);
    }
  }

  const changes = await collectChanges(canonicalPath, limits, base?.commit);

  if (changes.files.length === 0) {
    return {
      kind: 'empty_diff',
      message: base
        ? `No changes since ${base.ref}.`
        : 'No uncommitted changes found. If the work is already committed, review it with a base ref (e.g. base "HEAD~1" or "main").',
    };
  }

  let session;
  try {
    session = await resolveSession(canonicalPath, changes, {
      sessionId: options.sessionId,
      description: options.description,
      replies: options.replies,
      newSession: options.newSession,
      base,
    });
  } catch (err) {
    throw new WorkflowError((err as Error).message);
  }

  const webDistPath = await getWebDistPath();

  const reviewServer = await startReviewServer({
    session,
    webDistPath,
    port: options.port,
    timeout: options.timeout,
    limits,
    fingerprint: changes.fingerprint,
  });

  process.stderr.write(`Review server running at ${reviewServer.url}\n`);
  process.stderr.write(`Session: ${session.id}\n`);
  process.stderr.write(base ? `Comparing the working tree against ${base.ref} (${base.commit.slice(0, 12)})\n` : 'Reviewing uncommitted changes\n');
  const large = changes.files.filter((f) => f.large).length;
  process.stderr.write(
    `Reviewing ${changes.files.length} file(s)` +
      (large ? `, ${large} large (diff on demand)` : '') +
      (changes.skipped.length ? `, ${changes.skipped.length} binary skipped` : '') +
      '\n',
  );

  if (options.openBrowser !== false) {
    await open(reviewServer.url);
  }

  const result = await reviewServer.result;
  return { kind: 'reviewed', result, url: reviewServer.url };
}

export async function listSessions(repoPath: string): Promise<Session[]> {
  return listSessionsByRepo(await canonicalRepo(repoPath));
}

export async function getSessionById(sessionId: string): Promise<Session> {
  try {
    return await loadSession(sessionId);
  } catch (err) {
    throw new WorkflowError((err as Error).message);
  }
}
