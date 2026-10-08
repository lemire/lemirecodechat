---
name: lemirecodechat
description: Use lemirecodechat to request human code review of your changes. Use when the user asks to review code, get feedback on changes, or when you want the user to review your work before proceeding.
argument-hint: [review]
---

# lemirecodechat — Human-in-the-Loop Code Review

`lemirecodechat` opens a browser UI where the user reviews your uncommitted changes, leaves inline comments **and suggests concrete edits**, then submits — like a pull request, but locally.

**If the MCP tools `codechat_review` and `codechat_reply` are available, use those instead of the CLI.** The workflow below is the same.

## CLI Usage

Run from the repository root. It blocks until the user submits, then prints JSON to stdout:

```bash
lemirecodechat -d "Add user authentication"
```

The result has `sessionId`, `status` (`"approved"` or `"changes_requested"`) and `comments`. Each comment has `id`, `filePath`, `line`, optional `endLine`, `body`, `resolved`, and a `kind`:

- `"comment"` (or no `kind`): free-text feedback.
- `"suggestion"`: the reviewer edited the code directly. `suggestion.original` is the text of lines `line..endLine` of `filePath` when they made it, `suggestion.replacement` is what they want instead, and `suggestion.patch` is the same change as a unified diff. `body` is an optional rationale (may be empty).

Other commands:

```bash
lemirecodechat sessions            # list sessions for this repo
lemirecodechat sessions <id>       # print full session JSON
lemirecodechat -s <id>             # resume a specific session
```

## Workflow

1. **Review** — run `lemirecodechat` (or call `codechat_review`).
2. **Summarize** — before changing anything, list each unresolved comment and your plan, e.g.
   - **src/auth.ts:42** — "Validate the token expiry" → I'll add an expiry check.
   - **src/sum.c:11–13** — suggested replacing the tail loop with three `if`s → I'll apply it as suggested.
   Skip comments already resolved in earlier rounds.
3. **Fix** — apply suggestions faithfully: replace `original` with `replacement` exactly (use your edit tool with `original` as the old text). If the code moved, find `original` in the file; if it no longer exists or the suggestion is broken, don't guess — say so in your reply.
4. **Reply** — MCP: call `codechat_reply` (`resolved: true` when addressed, `false` for a clarifying question). CLI: run `lemirecodechat` again; the session resumes with previous comments.
5. **Repeat** until `status` is `"approved"`.

## Behavior

- Proactively offer a review after significant changes.
- Always summarize comments before making changes.
- Always resume the existing session (it is found automatically by repository path).
- Binary files are not shown to the reviewer, and very large diffs are only shown when the reviewer asks for them; mention it if a large or binary change matters for the review.
