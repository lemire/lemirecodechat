# lemirecodechat

Human-in-the-loop code review for AI agents: the agent opens a local browser UI on its uncommitted changes, you comment **or edit the code directly**, and your feedback goes back to the agent as structured JSON.

Derived from [alexmx/codechat](https://github.com/alexmx/codechat) (MIT). Differences from the original:

- **Suggested edits.** Switch the toolbar to **Edit** (or press `e`), then click or drag line numbers: an inline editor with syntax highlighting opens on those lines (extendable with *more above / more below*). The saved edit goes to the agent as a `suggestion` comment with `original`, `replacement` and a unified `patch`. Alt-click uses the other mode for one action (comment while in Edit mode, edit while in Comment mode). Suggestions can be re-opened and edited until submitted.
- **No binary files.** Binary files (git's own detection for tracked files, a NUL-byte check for untracked ones) are left out of the review; a note lists them.
- **Large diffs on demand.** Files whose diff exceeds 1000 changed lines or 256 KB are listed but not diffed; click **Load diff** to see one. Their diffs are not even computed until then, so a huge generated file no longer slows the review down. Thresholds: `--max-lines`, `--max-bytes`, or the `LEMIRECODECHAT_MAX_LINES` / `LEMIRECODECHAT_MAX_BYTES` environment variables.
- **Long lines wrap** instead of being cut off (toggle with *Wrap lines*; the choice is remembered). The editor wraps too.
- Repositories without commits are diffed against the empty tree, so unstaged edits to added files show up.
- The browser can only read files that are part of the review.
- **Committed work too.** `--base <ref>` (MCP: `base`) compares the working tree against a ref such as `main` or `HEAD~2`, so work the agent already committed can be reviewed. The page always says whether it shows uncommitted changes only or everything since a ref.
- **Only a submit approves.** A review that times out or whose tab is closed ends with `reason: "timeout"` / `"closed"` and is never `approved`.
- **Replies from the CLI.** `lemirecodechat reply` records the agent's answers (same shape as `codechat_reply`), so agents without MCP can resolve comments too.
- **Fresh start after approval.** An approved session is not resumed; the next review starts a new one. `--new` (MCP: `newSession`) starts over at any time.

## Install

Requires Node.js 20+ and git.

```bash
git clone https://github.com/lemire/lemirecodechat.git
cd lemirecodechat
npm install
npm run build
cd packages/cli && npm link      # puts `lemirecodechat` on your PATH
```

Check with `lemirecodechat --version`. To update later: `git pull && npm install && npm run build` (the link keeps pointing at your clone).

## Set it up in your AI agent

lemirecodechat runs as an MCP server (`lemirecodechat mcp`) that exposes two tools: `codechat_review` (opens the browser and waits for your review) and `codechat_reply` (records the agent's answers). Register it once with your agent, then ask the agent to "review my changes with lemirecodechat". `lemirecodechat mcp --setup` prints these commands too.

### Claude Code

```bash
claude mcp add --scope user --transport stdio lemirecodechat -- lemirecodechat mcp
```

Optionally, also install the skill so Claude knows the review workflow (and can use the CLI when MCP is off):

```bash
mkdir -p ~/.claude/skills && cp -R skills/lemirecodechat ~/.claude/skills/
```

### OpenAI Codex CLI

```bash
codex mcp add lemirecodechat -- lemirecodechat mcp
```

### Google Gemini CLI

```bash
gemini mcp add --scope user lemirecodechat lemirecodechat mcp
```

### xAI Grok CLI

```bash
grok mcp add lemirecodechat -- lemirecodechat mcp
```

Or by hand in `~/.grok/config.toml`:

```toml
[mcp_servers.lemirecodechat]
command = "lemirecodechat"
args = ["mcp"]
```

### Cursor

```bash
cursor --add-mcp '{"name":"lemirecodechat","command":"lemirecodechat","args":["mcp"]}'
```

### VS Code (GitHub Copilot agent mode)

```bash
code --add-mcp '{"name":"lemirecodechat","command":"lemirecodechat","args":["mcp"]}'
```

### Other MCP clients (Windsurf, Claude Desktop, opencode, …)

Most clients accept the common JSON form in their MCP configuration file:

```json
{
  "mcpServers": {
    "lemirecodechat": { "command": "lemirecodechat", "args": ["mcp"] }
  }
}
```

opencode uses its own shape in `opencode.json`:

```json
{
  "mcp": {
    "lemirecodechat": { "type": "local", "command": ["lemirecodechat", "mcp"] }
  }
}
```

### Agents without MCP

Any agent that can run shell commands can use the CLI: `lemirecodechat` blocks until you submit and prints the review as JSON, and `lemirecodechat reply` records the agent's answers. Put the contents of [`skills/lemirecodechat/SKILL.md`](skills/lemirecodechat/SKILL.md) in the agent's instructions (for example `AGENTS.md`) so it knows how to read comments and apply suggested edits.

If the agent cannot find `lemirecodechat` (GUI apps often have a reduced `PATH`), use the absolute path from `which lemirecodechat` as the command.

### Time limits

A review blocks until you submit (30 minutes at most by default). Agents that cap command or tool-call duration can cut it short: Claude Code's Bash tool stops commands after 2 minutes by default (10 at most), so the skill tells Claude to run the CLI in the background. If your MCP client limits tool-call duration, lower the review timeout below it (`-t <minutes>`, or the `timeoutMinutes` argument of `codechat_review`).

## CLI

```
lemirecodechat [options]                    review uncommitted changes
lemirecodechat reply [-f <file>] [-s <id>]  record replies (JSON from file or stdin)
lemirecodechat sessions [<id>]              list sessions / print one
lemirecodechat mcp [--setup]                MCP server over stdio / setup help

  -s, --session <id>         Resume a session
  --new                      Start a new session instead of resuming
  -b, --base <ref>           Also review commits: compare the working tree against <ref>
  -d, --description <text>   Describe the changes
  -p, --port <n>             Server port
  -t, --timeout <min>        Session timeout (default: 30)
  --max-lines <n>            Diffs with more changed lines load on demand (default: 1000)
  --max-bytes <n>            Diffs larger than this load on demand (default: 262144)
  --no-open                  Don't open the browser
  -f, --file <path>          reply: read replies from this file (default: stdin)
```

Replies are a JSON array (or `{ "replies": [...] }`) of `{ "commentId": "…", "body": "…", "resolved": false }`; `resolved` defaults to `true`.

Sessions are stored in `~/.local/share/lemirecodechat/sessions` (or `$XDG_DATA_HOME/lemirecodechat/sessions`).

## Result format

```json
{
  "sessionId": "…",
  "status": "changes_requested",
  "reason": "submitted",
  "summary": "Close, two nits.",
  "comments": [
    {
      "id": "…",
      "kind": "suggestion",
      "filePath": "fast.c",
      "line": 11,
      "endLine": 13,
      "side": "new",
      "body": "At most 3 leftovers, no loop needed.",
      "suggestion": {
        "original": "  for (; i < n; i++) {\n    s0 += data[i];\n  }",
        "replacement": "  if (i < n) s0 += data[i++];\n  if (i < n) s1 += data[i++];\n  if (i < n) s2 += data[i];",
        "patch": "--- a/fast.c\n+++ b/fast.c\n@@ -11,3 +11,3 @@\n-  for (; i < n; i++) {\n…"
      },
      "resolved": false
    }
  ]
}
```

- `status` is `approved` only when the reviewer submitted with no unresolved comment; `reason` is `submitted`, `timeout` or `closed`.
- `summary` is the reviewer's overall message from the submit dialog; `base` is present when the review covered commits.
- `side: "old"` marks a comment on a deleted line. Suggestions are always on the new side.
- `agentReply` holds the agent's reply from an earlier round.

## Development

```bash
npm run build       # CLI (tsup) + web UI (vite)
npm run typecheck
npm test            # integration tests over WebSocket: binary/large/suggestion flow, timeouts, replies, base refs
```

Layout: `packages/cli` (CLI, MCP server, HTTP/WebSocket review server, git handling in `git.ts`, suggestion patches in `suggestion.ts`) and `packages/web` (React UI; the editor is `components/SuggestionEditor.tsx`).

## License

MIT — see [LICENSE](LICENSE).
