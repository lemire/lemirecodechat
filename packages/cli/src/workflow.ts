import { isGitRepo, getRepoRoot, collectChanges, DEFAULT_LIMITS, type DiffLimits } from './git.js';
import { resolveSession, loadSession, saveSession, listSessionsByRepo } from './session.js';
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
  replies?: { commentId: string; body: string; resolved?: boolean }[];
  skipReview?: boolean;
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

/** Diff limits from options, falling back to LEMIRECODECHAT_MAX_LINES / LEMIRECODECHAT_MAX_BYTES, then defaults. */
export function resolveLimits(limits?: Partial<DiffLimits>): DiffLimits {
  const env = (name: string) => {
    const n = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    maxLines: limits?.maxLines ?? env('LEMIRECODECHAT_MAX_LINES') ?? DEFAULT_LIMITS.maxLines,
    maxBytes: limits?.maxBytes ?? env('LEMIRECODECHAT_MAX_BYTES') ?? DEFAULT_LIMITS.maxBytes,
  };
}

export type ReviewOutcome =
  | { kind: 'empty_diff' }
  | { kind: 'skipped'; result: ReviewResult }
  | { kind: 'reviewed'; result: ReviewResult; url: string };

export async function executeReview(options: ReviewOptions): Promise<ReviewOutcome> {
  if (!(await isGitRepo(options.repoPath))) {
    throw new WorkflowError('Not a git repository.');
  }

  const canonicalPath = await getRepoRoot(options.repoPath);
  const limits = resolveLimits(options.limits);
  const changes = await collectChanges(canonicalPath, limits);

  if (changes.files.length === 0) {
    return { kind: 'empty_diff' };
  }

  let session;
  try {
    session = await resolveSession(canonicalPath, changes, {
      sessionId: options.sessionId,
      description: options.description,
      replies: options.replies,
      newSession: options.newSession,
    });
  } catch (err) {
    throw new WorkflowError((err as Error).message);
  }

  if (options.skipReview) {
    await saveSession(session);
    const result: ReviewResult = {
      sessionId: session.id,
      status: session.status,
      comments: session.comments,
    };
    return { kind: 'skipped', result };
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
  if (!(await isGitRepo(repoPath))) {
    throw new WorkflowError('Not a git repository.');
  }
  const canonicalPath = await getRepoRoot(repoPath);
  return listSessionsByRepo(canonicalPath);
}

export async function getSessionById(sessionId: string): Promise<Session> {
  try {
    return await loadSession(sessionId);
  } catch (err) {
    throw new WorkflowError((err as Error).message);
  }
}
