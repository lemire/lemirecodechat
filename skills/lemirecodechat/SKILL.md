---
name: lemirecodechat
description: Open a local browser UI (lemirecodechat) so the user can review your changes themselves, comment inline and suggest edits, then apply their feedback. Use when the user wants to review your work ("let me review", "show me the diff", "review with lemirecodechat"), or offer it before committing significant changes. Not for reviewing code on the user's behalf.
---

# lemirecodechat: human review of your changes

`lemirecodechat` opens a browser page where the user reviews your changes like a pull request: inline comments, and **suggested edits** they type straight into the code. When they submit, you get the review as JSON.

**Use the MCP tools `codechat_review` and `codechat_reply` if they are available.** Otherwise use the CLI. The workflow is the same.

## Before you start

- **Scope.** By default only *uncommitted* changes are reviewed (working tree vs `HEAD`, untracked files included). If you already committed the work, pass a base ref covering your commits: `base: "HEAD~2"` (MCP) or `-b HEAD~2` (CLI), or the branch you started from (`main`). The page shows which scope it is.
- **Installed?** For the CLI path, check `command -v lemirecodechat`. If it is missing, point the user to the install steps in the lemirecodechat README (`npm install && npm run build && npm link` in a clone) instead of improvising.
- **New work vs. old session.** Sessions resume automatically per repository, keeping earlier comments and replies. An approved session is never resumed. If the last session is unfinished but your new work is unrelated, start fresh: `newSession: true` (MCP) or `--new` (CLI).

## Calling it

### MCP

- `codechat_review`: `repoPath` (required, absolute path inside the repository); optional `description` (shown to the reviewer), `base`, `newSession`, `sessionId`, `timeoutMinutes`. Blocks until the user submits.
- `codechat_reply`: `repoPath` and `replies`, an array of `{ commentId, body, resolved? }`. Returns at once.

Some MCP clients cap how long a tool call may run. If yours does, pass `timeoutMinutes` below that limit.

### CLI

Run from the repository; it blocks until the user submits, then prints JSON on stdout (logs go to stderr):

```bash
lemirecodechat -d "Add user authentication"        # uncommitted changes
lemirecodechat -b main -d "Add user authentication" # everything since main
```

**The review can take many minutes; do not let your shell tool kill it.** In Claude Code the Bash tool times out after 2 minutes by default (10 at most): run the command in the background (`run_in_background`) and wait for it to finish, or set the tool timeout to its maximum and pass `-t 9` so the review ends first.

Record replies (JSON array, or `{ "replies": [...] }`, from a file or stdin):

```bash
lemirecodechat reply <<'EOF'
[{ "commentId": "…", "body": "Added the expiry check." },
 { "commentId": "…", "body": "Should this also cover refresh tokens?", "resolved": false }]
EOF
```

Other commands: `lemirecodechat sessions` (list), `lemirecodechat sessions <id>` (full JSON), `-s <id>` (resume a given session), `--new`, `-t <minutes>`, `--no-open`, `-p <port>`.

## Reading the result

```
{ sessionId, status, reason, summary?, base?, comments: [...] }
```

- **`reason`** says how the round ended: `"submitted"` (the user clicked Submit), `"timeout"`, or `"closed"` (all tabs closed). **Only `status: "approved"` with `reason: "submitted"` is an approval.** On `timeout` or `closed`, tell the user the review was not finished and ask what to do; never treat silence as sign-off.
- **`summary`**: the reviewer's overall message. Read it first.
- Each comment has `id`, `filePath`, `line`, optional `endLine`, `side`, `body`, `resolved`, optional `agentReply` (your reply from an earlier round) and `kind`:
  - `"comment"` (or no `kind`): free-text feedback.
  - `"suggestion"`: the reviewer edited the code. `suggestion.original` is the exact text of lines `line..endLine` of `filePath` when they made it, `suggestion.replacement` is what they want there, `suggestion.patch` is the same change as a unified diff. `body` is an optional rationale.
  - `side: "old"`: the comment is on a *deleted* line. The reviewer is questioning the deletion; it is not an edit to make at that line number.

## Workflow

1. **Review**: call `codechat_review` or run `lemirecodechat`.
2. **Check `reason`** (see above), then read `summary`.
3. **Summarize** every unresolved comment and your plan *before* changing anything, e.g.
   - **src/auth.ts:42**: "Validate the token expiry" → add an expiry check.
   - **src/sum.c:11–13**: suggested edit replacing the tail loop with three `if`s → apply as suggested.

   Skip comments already resolved in earlier rounds.
4. **Apply suggestions first**, faithfully:
   - Use your edit tool with `suggestion.original` as the exact search text and `suggestion.replacement` as the new text. Preserve every character, including indentation and trailing whitespace.
   - With several suggestions in one file, apply them **bottom-up** (highest `line` first) and **before** any other edit to that file, so the remaining ones still match.
   - If the edit tool takes unified diffs, `suggestion.patch` is an alternative.
   - If `original` is no longer in the file, **do not guess or fuzz the match**. Leave the code alone and report it in your reply (file, line range, "original text no longer present"), with `resolved: false`.
5. **Make the other fixes.**
6. **Reply**: `codechat_reply`, or `lemirecodechat reply`. One reply per comment you addressed. `resolved` defaults to true; set it to `false` for a question or a change you did not make.
7. **Another round?** If `status` was `"changes_requested"`, ask the user whether they want to look again before re-running the review: each round waits on them. The next round shows your replies next to their comments.

## Common failures

- `lemirecodechat: command not found` (GUI agents often have a reduced `PATH`): use the absolute path from `which lemirecodechat`, or ask the user to install it.
- "No uncommitted changes found": if you committed the work, re-run with a base ref. Otherwise tell the user there is nothing to review and stop.
- The browser does not open: re-run with `--no-open` and give the user the URL printed on stderr (`Review server running at …`). Port conflict: `-p <port>`.
- The review seems stuck or you lost the result: `lemirecodechat sessions` shows each session's status; `lemirecodechat sessions <id>` prints its comments.
- Binary files are not shown and very large diffs load only on request: mention it if such a change matters for the review.
