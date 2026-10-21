#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { version } from './version.js';
import { executeReview, recordReplies, getSessionById, listSessions, WorkflowError } from './workflow.js';
import type { Reply } from './session.js';

function printUsage(): void {
  console.error(`
Usage: lemirecodechat [options]                    review uncommitted changes
       lemirecodechat reply [-f <file>] [-s <id>]  record replies (JSON from file or stdin)
       lemirecodechat sessions [<id>]              list sessions / print one
       lemirecodechat mcp [--setup]                MCP server over stdio / setup help

Options:
  -s, --session <id>         Resume a session
  --new                      Start a new session instead of resuming
  -b, --base <ref>           Also review commits: compare the working tree against <ref>
  -d, --description <text>   Describe the changes
  -p, --port <n>             Server port
  -t, --timeout <min>        Session timeout (default: 30)
  -f, --file <path>          reply: read replies from this file (default: stdin)
  --max-lines <n>            Show diffs with more changed lines on demand only (default: 1000)
  --max-bytes <n>            Show diffs larger than this on demand only (default: 262144)
  --max-total-bytes <n>      Once inline diffs reach this total, show the rest on demand only (default: 1048576)
  --max-total-lines <n>      Once inline diffs reach this many changed lines, show the rest on demand only (default: 5000)
  --no-open                  Don't open browser
  -v, --version              Show version
  -h, --help                 Show this help
`);
}

function printMcpSetup(): void {
  console.log(`Add lemirecodechat as an MCP server to your AI coding agent:

  Claude Code:          claude mcp add --scope user --transport stdio lemirecodechat -- lemirecodechat mcp
  Codex CLI:            codex mcp add lemirecodechat -- lemirecodechat mcp
  Gemini CLI:           gemini mcp add --scope user lemirecodechat lemirecodechat mcp
  Grok CLI:             grok mcp add lemirecodechat -- lemirecodechat mcp
  VS Code / Copilot:    code --add-mcp '{"name":"lemirecodechat","command":"lemirecodechat","args":["mcp"]}'
  Cursor:               cursor --add-mcp '{"name":"lemirecodechat","command":"lemirecodechat","args":["mcp"]}'

  Other clients (JSON config):
    { "mcpServers": { "lemirecodechat": { "command": "lemirecodechat", "args": ["mcp"] } } }`);
}

async function runReview(options: {
  session?: string;
  new?: boolean;
  base?: string;
  description?: string;
  port?: string;
  timeout?: string;
  'no-open'?: boolean;
  'max-lines'?: string;
  'max-bytes'?: string;
  'max-total-bytes'?: string;
  'max-total-lines'?: string;
}): Promise<void> {
  const outcome = await executeReview({
    repoPath: process.cwd(),
    sessionId: options.session,
    newSession: options.new,
    base: options.base,
    description: options.description,
    port: options.port ? parseInt(options.port, 10) : undefined,
    timeout: options.timeout ? parseInt(options.timeout, 10) * 60_000 : undefined,
    openBrowser: !options['no-open'],
    limits: {
      maxLines: options['max-lines'] ? parseInt(options['max-lines'], 10) : undefined,
      maxBytes: options['max-bytes'] ? parseInt(options['max-bytes'], 10) : undefined,
      maxTotalBytes: options['max-total-bytes'] ? parseInt(options['max-total-bytes'], 10) : undefined,
      maxTotalLines: options['max-total-lines'] ? parseInt(options['max-total-lines'], 10) : undefined,
    },
  });

  switch (outcome.kind) {
    case 'empty_diff':
      console.error(outcome.message);
      process.exit(0);
      break;
    case 'skipped':
    case 'reviewed':
      console.log(JSON.stringify(outcome.result, null, 2));
      break;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new WorkflowError('reply expects JSON on stdin or --file <path>.');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/** Accepts `[{commentId, body, resolved?}, ...]` or `{ "replies": [...] }`. */
function parseReplies(text: string): Reply[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new WorkflowError(`Replies are not valid JSON: ${(err as Error).message}`);
  }
  const list = Array.isArray(json) ? json : (json as { replies?: unknown })?.replies;
  if (!Array.isArray(list) || list.length === 0) {
    throw new WorkflowError('Expected a non-empty array of replies, or { "replies": [...] }.');
  }
  return list.map((r, i) => {
    if (typeof r?.commentId !== 'string' || typeof r?.body !== 'string') {
      throw new WorkflowError(`Reply ${i}: needs string "commentId" and "body".`);
    }
    if (r.resolved !== undefined && typeof r.resolved !== 'boolean') {
      throw new WorkflowError(`Reply ${i}: "resolved" must be true or false.`);
    }
    return { commentId: r.commentId, body: r.body, ...(r.resolved !== undefined ? { resolved: r.resolved } : {}) };
  });
}

async function runReply(options: { file?: string; session?: string }): Promise<void> {
  const text = options.file ? await readFile(options.file, 'utf-8') : await readStdin();
  const result = await recordReplies(process.cwd(), parseReplies(text), options.session);
  console.log(JSON.stringify(result, null, 2));
}

async function runSessions(sessionId?: string): Promise<void> {
  if (sessionId) {
    const session = await getSessionById(sessionId);
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  const sessions = await listSessions(process.cwd());
  if (sessions.length === 0) {
    console.error('No sessions found for this repository.');
    return;
  }
  for (const s of sessions) {
    const date = new Date(s.updatedAt).toLocaleString();
    const comments = s.comments.length;
    const pending = s.comments.filter((c) => !c.resolved).length;
    const desc = s.description ? `  ${s.description}` : '';
    const commentInfo = comments > 0
      ? ` (${comments} comment${comments !== 1 ? 's' : ''}${pending > 0 ? `, ${pending} pending` : ''})`
      : '';
    console.log(`${s.id}  ${s.status.padEnd(17)}  ${date}${commentInfo}${desc}`);
  }
}

async function runMcp(): Promise<void> {
  const { startMcpServer } = await import('./mcp-server.js');
  await startMcpServer();
}

process.on('SIGINT', () => {
  process.stderr.write('\nReview cancelled.\n');
  process.exit(130);
});

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      session: { type: 'string', short: 's' },
      new: { type: 'boolean' },
      base: { type: 'string', short: 'b' },
      file: { type: 'string', short: 'f' },
      description: { type: 'string', short: 'd' },
      port: { type: 'string', short: 'p' },
      timeout: { type: 'string', short: 't' },
      'no-open': { type: 'boolean' },
      'max-lines': { type: 'string' },
      'max-bytes': { type: 'string' },
      'max-total-bytes': { type: 'string' },
      'max-total-lines': { type: 'string' },
      setup: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
  });

  const command = positionals[0];

  if (values.version) {
    console.log(version);
    process.exit(0);
  }

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (command === 'reply') {
    await runReply(values);
  } else if (command === 'sessions') {
    await runSessions(positionals[1]);
  } else if (command === 'mcp') {
    if (values.setup) {
      printMcpSetup();
      process.exit(0);
    }
    await runMcp();
  } else if (!command) {
    await runReview(values);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof WorkflowError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  console.error(err.message);
  process.exit(1);
});
