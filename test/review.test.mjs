// Integration test: drives a real review server over WebSocket against a scratch git repo.
// Run `npm run build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { executeReview } from '../packages/cli/dist/index.js';

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
