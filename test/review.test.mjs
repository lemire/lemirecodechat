// Integration test: drives a real review server over WebSocket against a scratch git repo.
// Run `npm run build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { executeReview, recordReplies } from '../packages/cli/dist/index.js';

const CLI = new URL('../packages/cli/dist/cli.js', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lemirecodechat-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'small.c'), 'int main() {\n  return 0;\n}\n');
  writeFileSync(join(dir, 'big.txt'), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n');
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  writeFileSync(join(dir, 'small.c'), 'int main() {\n  int x = 1;\n  return x;\n}\n');
  writeFileSync(join(dir, 'big.txt'), Array.from({ length: 2000 }, (_, i) => `changed ${i}`).join('\n') + '\n');
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 2]));
  writeFileSync(join(dir, 'new.py'), 'print("hi")\n');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(dir, 'long.js'), `const s = "${'x'.repeat(2000)}";\n`);
  return dir;
}

function connect(url) {
  const ws = new WebSocket(url.replace(/^http/, 'ws').replace(/\/[^/]*$/, ''));
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i !== -1) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (type) => {
      const i = queue.findIndex((m) => m.type === type);
      if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

test('review with binary, large and suggestion', async () => {
  const dir = makeRepo();
  process.env.XDG_DATA_HOME = join(dir, '.xdg');
  writeFileSync(join(dir, '.gitignore'), '.xdg/\n');
  try {
    let url;
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      const m = /running at (\S+)/.exec(String(chunk));
      if (m) url = m[1];
      return origWrite(chunk, ...rest);
    };
    let failure;
    const outcomePromise = executeReview({ repoPath: dir, openBrowser: false, newSession: true });
    outcomePromise.catch((err) => { failure = err; });
    for (let i = 0; !url && !failure && i < 500; i++) await new Promise((r) => setTimeout(r, 20));
    if (failure) throw failure;
    assert.ok(url, 'review server did not start');
    process.stderr.write = origWrite;

    const client = connect(url);
    const { data: session } = await client.next('init');

    const paths = session.files.map((f) => f.path);
    assert.deepEqual(paths, ['.gitignore', 'big.txt', 'long.js', 'new.py', 'small.c']);
    assert.deepEqual(session.skipped.map((s) => s.path), ['blob.bin', 'logo.png']);
    assert.equal(session.files.find((f) => f.path === 'big.txt').large, true);
    assert.equal(session.files.find((f) => f.path === 'long.js').large, undefined);
    assert.ok(!session.diff.includes('changed 1'), 'large diff must not be inlined');
    assert.ok(!session.diff.includes('logo.png'), 'binary must not appear');
    assert.ok(session.diff.includes('+  int x = 1;'));

    client.send({ type: 'request_file_diff', data: { filePath: 'big.txt' } });
    const { data: big } = await client.next('file_diff');
    assert.equal(big.filePath, 'big.txt');
    assert.ok(big.diff.includes('+changed 1999'));

    // Files outside the review are refused
    client.send({ type: 'request_file_content', data: { filePath: '../../etc/passwd' } });
    client.send({ type: 'request_file_content', data: { filePath: 'small.c' } });
    const { data: content } = await client.next('file_content');
    assert.equal(content.filePath, 'small.c');
    assert.equal(content.oldContent, 'int main() {\n  return 0;\n}\n');

    client.send({
      type: 'add_comment',
      data: { filePath: 'small.c', line: 2, endLine: 3, side: 'new', body: 'simpler', kind: 'suggestion', replacement: '  return 1;' },
    });
    const { data: suggestion } = await client.next('comment_added');
    assert.equal(suggestion.kind, 'suggestion');
    assert.equal(suggestion.suggestion.original, '  int x = 1;\n  return x;');
    assert.equal(suggestion.suggestion.replacement, '  return 1;');
    assert.match(suggestion.suggestion.patch, /@@ -2,2 \+2,1 @@\n-  int x = 1;\n-  return x;\n\+  return 1;/);

    client.send({ type: 'edit_comment', data: { id: suggestion.id, body: 'simpler', replacement: '  return 2;' } });
    const { data: edited } = await client.next('comment_edited');
    assert.equal(edited.suggestion.replacement, '  return 2;');

    client.send({ type: 'add_comment', data: { filePath: 'new.py', line: 1, side: 'new', body: 'use logging' } });
    await client.next('comment_added');

    client.send({ type: 'submit_review' });
    const outcome = await outcomePromise;
    assert.equal(outcome.result.status, 'changes_requested');
    assert.equal(outcome.result.comments.length, 2);
    assert.equal(outcome.result.comments[0].suggestion.replacement, '  return 2;');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Start a review and wait until its server is listening; returns { url, outcome }. */
async function startReview(options) {
  let url;
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    const m = /running at (\S+)/.exec(String(chunk));
    if (m) url = m[1];
    return origWrite(chunk, ...rest);
  };
  let failure;
  const outcome = executeReview({ openBrowser: false, ...options });
  outcome.catch((err) => { failure = err; });
  try {
    for (let i = 0; !url && !failure && i < 500; i++) await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.stderr.write = origWrite;
  }
  if (failure) throw failure;
  assert.ok(url, 'review server did not start');
  return { url, outcome };
}

function smallRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lemirecodechat-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, '.gitignore'), '.xdg/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  process.env.XDG_DATA_HOME = join(dir, '.xdg');
  return { dir, git };
}

test('a timeout or a closed tab is never an approval', async () => {
  const { dir } = smallRepo();
  try {
    const timedOut = await (await startReview({ repoPath: dir, timeout: 200 })).outcome;
    assert.equal(timedOut.result.reason, 'timeout');
    assert.equal(timedOut.result.status, 'pending');

    const { url, outcome } = await startReview({ repoPath: dir });
    const client = connect(url);
    await client.next('init');
    client.ws.close();
    const closed = await outcome;
    assert.equal(closed.result.reason, 'closed');
    assert.equal(closed.result.status, 'pending');
    assert.equal(closed.result.sessionId, timedOut.result.sessionId, 'unfinished session is resumed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approval needs a submit, and approved sessions are not resumed', async () => {
  const { dir } = smallRepo();
  try {
    const { url, outcome } = await startReview({ repoPath: dir });
    const client = connect(url);
    await client.next('init');
    client.send({ type: 'submit_review', data: { summary: 'LGTM' } });
    const approved = await outcome;
    assert.equal(approved.result.status, 'approved');
    assert.equal(approved.result.reason, 'submitted');
    assert.equal(approved.result.summary, 'LGTM');

    const next = await (await startReview({ repoPath: dir, timeout: 100 })).outcome;
    assert.notEqual(next.result.sessionId, approved.result.sessionId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replies resolve comments, from the API and from the CLI', async () => {
  const { dir } = smallRepo();
  try {
    const { url, outcome } = await startReview({ repoPath: dir });
    const client = connect(url);
    await client.next('init');
    client.send({ type: 'add_comment', data: { filePath: 'a.txt', line: 2, side: 'new', body: 'why two?' } });
    const { data: c1 } = await client.next('comment_added');
    client.send({ type: 'add_comment', data: { filePath: 'a.txt', line: 1, side: 'new', body: 'capitalize' } });
    const { data: c2 } = await client.next('comment_added');
    client.send({ type: 'submit_review' });
    const first = await outcome;
    assert.equal(first.result.status, 'changes_requested');

    await assert.rejects(recordReplies(dir, [{ commentId: 'nope', body: 'x' }]), /Unknown comment id/);

    const afterApi = await recordReplies(dir, [{ commentId: c1.id, body: 'needed later', resolved: false }]);
    const r1 = afterApi.comments.find((c) => c.id === c1.id);
    assert.equal(r1.agentReply, 'needed later');
    assert.equal(r1.resolved, false);

    const stdout = execFileSync(process.execPath, [CLI, 'reply'], {
      cwd: dir,
      env: process.env,
      input: JSON.stringify({ replies: [{ commentId: c2.id, body: 'done' }] }),
    });
    const afterCli = JSON.parse(stdout.toString());
    const r2 = afterCli.comments.find((c) => c.id === c2.id);
    assert.equal(r2.agentReply, 'done');
    assert.equal(r2.resolved, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('committed work is reviewed with a base ref', async () => {
  const { dir, git } = smallRepo();
  try {
    git('commit', '-q', '-am', 'two');
    const empty = await executeReview({ repoPath: dir, openBrowser: false });
    assert.equal(empty.kind, 'empty_diff');
    assert.match(empty.message, /base/);

    await assert.rejects(executeReview({ repoPath: dir, openBrowser: false, base: 'no-such-ref' }), /Unknown base/);

    const { url, outcome } = await startReview({ repoPath: dir, base: 'HEAD~1' });
    const client = connect(url);
    const { data: session } = await client.next('init');
    assert.equal(session.base, 'HEAD~1');
    assert.deepEqual(session.files.map((f) => f.path), ['a.txt']);
    client.send({ type: 'request_file_content', data: { filePath: 'a.txt' } });
    const { data: content } = await client.next('file_content');
    assert.equal(content.oldContent, 'one\n');
    client.send({ type: 'submit_review' });
    const done = await outcome;
    assert.equal(done.result.base, 'HEAD~1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
