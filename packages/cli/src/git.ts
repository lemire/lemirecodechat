import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import parseDiff from 'parse-diff';
import type { FileSummary, SkippedFile } from './types.js';

export interface DiffLimits {
  /** Files with more changed lines (additions + deletions) are not diffed until requested. */
  maxLines: number;
  /** Files whose diff (or untracked content) exceeds this many bytes are not diffed until requested. */
  maxBytes: number;
  /**
   * Budget for all inline diffs together. Once it is spent, the remaining files are
   * listed but only diffed on demand, so a change set with many files (a build output
   * directory left untracked, say) does not swamp the browser.
   */
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: DiffLimits = {
  maxLines: 1000,
  maxBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
};

/** Hard cap on anything we send to the browser on demand (diffs, file contents). */
export const MAX_ON_DEMAND_BYTES = 20 * 1024 * 1024;

/** Same heuristic as git: a NUL byte in the first 8000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000;

/** Untracked files above this size are not read at all to count their lines. */
const MAX_LINE_COUNT_BYTES = 64 * 1024 * 1024;

export class OutputTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Output exceeds ${Math.round(limit / (1024 * 1024))} MB`);
    this.name = 'OutputTooLargeError';
  }
}

function git(cwd: string, args: string[], { maxBytes = 512 * 1024 * 1024 } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=off', '--literal-pathspecs', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (tooLarge) return reject(new OutputTooLargeError(maxBytes));
      if (code === 0) return resolve(Buffer.concat(chunks).toString('utf-8'));
      reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

export async function getRepoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

/**
 * What to diff the working tree against: HEAD, or the empty tree in a repository
 * without commits (so every tracked file shows up as added).
 */
async function getDiffBase(cwd: string): Promise<string> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return 'HEAD';
  } catch {
    return (await git(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
  }
}

/** Resolve a ref (branch, tag, `HEAD~2`, SHA) to a commit SHA, or throw a readable error. */
export async function resolveCommit(cwd: string, ref: string): Promise<string> {
  if (ref.startsWith('-')) throw new Error(`Invalid base: ${ref}`);
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  } catch {
    throw new Error(`Unknown base: ${ref} (not a commit in this repository)`);
  }
}

const DIFF_FLAGS = ['-M', '--no-color', '--no-ext-diff'];

const PATHS_PER_GIT_CALL = 500;

interface TrackedEntry {
  path: string;
  oldPath?: string;
  status: FileSummary['status'];
  additions: number;
  deletions: number;
  binary: boolean;
}

function parseNameStatus(raw: string): Map<string, { status: FileSummary['status']; oldPath?: string }> {
  const tokens = raw.split('\0');
  const result = new Map<string, { status: FileSummary['status']; oldPath?: string }>();
  let i = 0;
  while (i < tokens.length && tokens[i]) {
    const code = tokens[i++][0];
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      result.set(path, { status: code === 'R' ? 'renamed' : 'added', oldPath });
    } else {
      const path = tokens[i++];
      const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
      result.set(path, { status });
    }
  }
  return result;
}

function parseNumstat(raw: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const tokens = raw.split('\0');
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  let i = 0;
  while (i < tokens.length && tokens[i]) {
    const [adds, dels, inlinePath] = tokens[i++].split('\t');
    // Renames have an empty inline path followed by the old and new paths as separate tokens
    const path = inlinePath ? inlinePath : (i++, tokens[i++]);
    const binary = adds === '-' && dels === '-';
    result.set(path, {
      additions: binary ? 0 : parseInt(adds, 10),
      deletions: binary ? 0 : parseInt(dels, 10),
      binary,
    });
  }
  return result;
}

async function getTrackedChanges(cwd: string, base: string): Promise<{ entries: TrackedEntry[]; raw: string }> {
  const [nameStatus, numstat] = await Promise.all([
    git(cwd, ['diff', base, ...DIFF_FLAGS, '--name-status', '-z']),
    git(cwd, ['diff', base, ...DIFF_FLAGS, '--numstat', '-z']),
  ]);
  const statuses = parseNameStatus(nameStatus);
  const counts = parseNumstat(numstat);
  const entries: TrackedEntry[] = [];
  for (const [path, { status, oldPath }] of statuses) {
    const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
    entries.push({ path, oldPath, status, ...count });
  }
  return { entries, raw: nameStatus + '\n' + numstat };
}

async function getUntrackedFiles(cwd: string): Promise<string[]> {
  const stdout = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  return stdout.split('\0').filter(Boolean);
}

async function isBinaryFile(fullPath: string): Promise<boolean> {
  const handle = await open(fullPath, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function countLines(fullPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let lines = 0;
    let lastByte = -1;
    createReadStream(fullPath)
      .on('data', (chunk) => {
        const buf = chunk as Buffer;
        for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
        if (buf.length > 0) lastByte = buf[buf.length - 1];
      })
      .on('end', () => resolve(lastByte !== -1 && lastByte !== 10 ? lines + 1 : lines))
      .on('error', reject);
  });
}

/** Read a working-tree file as text, refusing binary or oversized files. */
export async function readTextFile(cwd: string, filePath: string, maxBytes = MAX_ON_DEMAND_BYTES): Promise<string> {
  const fullPath = join(cwd, filePath);
  const info = await stat(fullPath);
  if (!info.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  if (info.size > maxBytes) throw new OutputTooLargeError(maxBytes);
  if (await isBinaryFile(fullPath)) throw new Error(`Binary file: ${filePath}`);
  const handle = await open(fullPath, 'r');
  try {
    return await handle.readFile('utf-8');
  } finally {
    await handle.close();
  }
}

/** Build a "new file" diff for an untracked text file. */
function untrackedDiff(filePath: string, content: string): string {
  const header = [`diff --git a/${filePath} b/${filePath}`, 'new file mode 100644'];
  if (content === '') return header.join('\n') + '\n';
  const lines = content.split('\n');
  const endsWithNewline = lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();
  const body = lines.map((line) => `+${line}`);
  if (!endsWithNewline) body.push('\\ No newline at end of file');
  return [...header, '--- /dev/null', `+++ b/${filePath}`, `@@ -0,0 +1,${lines.length} @@`, ...body].join('\n') + '\n';
}

/** Split a multi-file unified diff into one chunk per file. */
function splitDiffByFile(diff: string): string[] {
  const chunks: string[] = [];
  let start = -1;
  let pos = 0;
  while (pos < diff.length) {
    if (diff.startsWith('diff --git ', pos)) {
      if (start !== -1) chunks.push(diff.slice(start, pos));
      start = pos;
    }
    const nl = diff.indexOf('\n', pos);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (start !== -1) chunks.push(diff.slice(start));
  return chunks;
}

function chunkPath(chunk: string): string | undefined {
  const [file] = parseDiff(chunk);
  if (!file) return undefined;
  return file.to && file.to !== '/dev/null' ? file.to : file.from;
}

export interface CollectedChanges {
  /** Unified diff of the files shown inline. */
  diff: string;
  files: FileSummary[];
  skipped: SkippedFile[];
  /** Changes whenever anything in the reviewable change set changes; used to detect live updates. */
  fingerprint: string;
}

/**
 * Gather every uncommitted change (tracked and untracked) in the repository, or,
 * when `baseCommit` is given, every change in the working tree since that commit.
 * Binary files are left out entirely. Files whose diff would be large are listed
 * with `large: true` and their diff is not generated; use `getFileDiff` for those.
 */
export async function collectChanges(
  cwd: string,
  limits: DiffLimits = DEFAULT_LIMITS,
  baseCommit?: string,
): Promise<CollectedChanges> {
  const base = baseCommit ?? (await getDiffBase(cwd));
  const [{ entries, raw }, untracked] = await Promise.all([getTrackedChanges(cwd, base), getUntrackedFiles(cwd)]);

  const files: FileSummary[] = [];
  const skipped: SkippedFile[] = [];
  const fingerprint = createHash('sha256').update(raw);

  const smallTracked: TrackedEntry[] = [];
  for (const entry of entries) {
    if (entry.binary) {
      skipped.push({ path: entry.path, reason: 'binary' });
      continue;
    }
    const summary: FileSummary = {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      additions: entry.additions,
      deletions: entry.deletions,
    };
    if (entry.additions + entry.deletions > limits.maxLines) {
      summary.large = true;
      // numstat alone can miss an edit to a large file that keeps the counts identical
      try {
        const info = await stat(join(cwd, entry.path));
        fingerprint.update(`${entry.path}:${info.size}:${info.mtimeMs}\n`);
      } catch { /* deleted */ }
    } else {
      smallTracked.push(entry);
    }
    files.push(summary);
  }

  const diffParts: string[] = [];
  let budget = limits.maxTotalBytes;

  if (smallTracked.length > 0) {
    // git diff has no --pathspec-from-file, so pass paths as arguments in batches.
    // A rename's old and new paths go in the same batch so it is still detected.
    const batches: string[][] = [[]];
    for (const e of smallTracked) {
      if (batches[batches.length - 1].length >= PATHS_PER_GIT_CALL) batches.push([]);
      batches[batches.length - 1].push(...(e.oldPath ? [e.oldPath, e.path] : [e.path]));
    }
    const outputs = await Promise.all(batches.map((paths) => git(cwd, ['diff', base, ...DIFF_FLAGS, '--', ...paths])));
    const trackedDiff = outputs.join('');
    const byPath = new Map(files.map((f) => [f.path, f]));
    for (const chunk of splitDiffByFile(trackedDiff)) {
      const path = chunkPath(chunk);
      const summary = path ? byPath.get(path) : undefined;
      // A few long lines can make a diff heavy even with a small line count
      const bytes = Buffer.byteLength(chunk);
      if (summary && (bytes > limits.maxBytes || bytes > budget)) {
        summary.large = true;
        continue;
      }
      budget -= bytes;
      diffParts.push(chunk);
    }
  }

  for (const path of untracked) {
    const fullPath = join(cwd, path);
    let info;
    try {
      info = await stat(fullPath);
      if (!info.isFile()) continue;
      if (await isBinaryFile(fullPath)) {
        skipped.push({ path, reason: 'binary' });
        continue;
      }
    } catch {
      continue; // vanished or unreadable
    }
    fingerprint.update(`?${path}:${info.size}:${info.mtimeMs}\n`);

    // The synthesized diff is about as large as the file itself
    if (info.size > limits.maxBytes || info.size > budget) {
      const additions = info.size <= MAX_LINE_COUNT_BYTES ? await countLines(fullPath).catch(() => 0) : 0;
      files.push({ path, status: 'added', additions, deletions: 0, large: true });
      continue;
    }
    let content: string;
    try {
      content = await readTextFile(cwd, path);
    } catch {
      continue;
    }
    const diff = untrackedDiff(path, content);
    const additions = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    const summary: FileSummary = { path, status: 'added', additions, deletions: 0 };
    if (additions > limits.maxLines || Buffer.byteLength(diff) > budget) {
      summary.large = true;
    } else {
      budget -= Buffer.byteLength(diff);
      diffParts.push(diff);
    }
    files.push(summary);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));

  const diff = diffParts.map((p) => (p.endsWith('\n') ? p : p + '\n')).join('');
  fingerprint.update(diff);

  return { diff, files, skipped, fingerprint: fingerprint.digest('hex') };
}

/** Generate the diff of a single file on demand (used for large files). */
export async function getFileDiff(cwd: string, file: FileSummary, baseCommit?: string): Promise<string> {
  const base = baseCommit ?? (await getDiffBase(cwd));
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const tracked = await git(cwd, ['diff', base, ...DIFF_FLAGS, '--', ...paths], { maxBytes: MAX_ON_DEMAND_BYTES });
  if (tracked.trim()) return tracked;
  // Not tracked: synthesize a "new file" diff
  return untrackedDiff(file.path, await readTextFile(cwd, file.path));
}

/** Content of a file at HEAD (or at `baseCommit`), or null if it does not exist there. */
export async function getBaseContent(cwd: string, filePath: string, baseCommit = 'HEAD'): Promise<string | null> {
  try {
    return await git(cwd, ['show', `${baseCommit}:${filePath}`], { maxBytes: MAX_ON_DEMAND_BYTES });
  } catch {
    return null;
  }
}
