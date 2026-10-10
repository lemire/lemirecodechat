import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { version } from './version.js';
import { executeReview, recordReplies, WorkflowError } from './workflow.js';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'lemirecodechat',
    version,
  });

  server.tool(
    'codechat_review',
    `Open a local browser UI where the user reviews your changes themselves: inline comments and suggested edits, like a pull request. Blocks until the user submits (or the session times out). Use when the user wants to review your work, not to review code on their behalf.

Scope: by default only UNCOMMITTED changes (working tree vs HEAD, untracked files included). If you already committed the work, pass base (e.g. "HEAD~1", "main") to compare the working tree against that ref.

Result: { sessionId, status, reason, summary?, base?, comments }.
- Trust status "approved" only when reason is "submitted". reason "timeout" or "closed" means the user did not finish: say so and ask; never treat it as sign-off.
- Read summary (the reviewer's overall message) first.
- Each comment: id, filePath, line, endLine?, side, body, resolved, agentReply? (your reply from an earlier round), kind.
  - side "old": the comment is on a deleted line; the reviewer questions the deletion, it is not an edit request.
  - kind "suggestion": the reviewer edited the code. suggestion.original is the exact text of lines line..endLine when they made it, suggestion.replacement is what they want, suggestion.patch is the same change as a unified diff. Apply by exact search-and-replace of original (every character, whitespace included). With several suggestions in one file, apply them bottom-up, before any other edit to that file. If original is no longer present, do not improvise: report the mismatch in your reply.

Workflow:
1. Summarize each unresolved comment (file:line, what was asked) and your plan, before changing anything. Skip resolved comments.
2. Make the fixes.
3. Call codechat_reply with one reply per comment you addressed.
4. If status was "changes_requested", ask the user whether they want another round before calling codechat_review again (each round waits on them).

Sessions resume automatically by repository (comments and replies are kept), except an approved session: the next review starts fresh. Pass newSession: true to start over anyway, for example when unrelated new work follows an unfinished review.`,
    {
      repoPath: z.string().describe('Absolute path to the git repository (its root or any directory inside it)'),
      sessionId: z.string().optional().describe('Session ID to resume a specific past session. Usually not needed: sessions are found by repoPath.'),
      description: z.string().optional().describe('Brief description of the changes (e.g. "Add user authentication"). Shown to the reviewer.'),
      newSession: z.boolean().optional().describe('Start a fresh session instead of resuming the current one (e.g. unrelated new work, or the user asks to start over).'),
      base: z.string().optional().describe('Also review committed work: compare the working tree against this ref (e.g. "HEAD~1", "main"). Omit to review uncommitted changes only.'),
      timeoutMinutes: z.number().int().positive().optional().describe('Minutes before the review ends without a submit (default 30). Keep it below any tool-call time limit of your client.'),
    },
    async ({ repoPath, sessionId, description, newSession, base, timeoutMinutes }) => {
      try {
        const outcome = await executeReview({
          repoPath,
          sessionId,
          description,
          newSession,
          base,
          timeout: timeoutMinutes ? timeoutMinutes * 60_000 : undefined,
          openBrowser: true,
        });

        if (outcome.kind === 'empty_diff') {
          return { content: [{ type: 'text' as const, text: outcome.message }] };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(outcome.result, null, 2) }],
        };
      } catch (err) {
        if (err instanceof WorkflowError) {
          return { content: [{ type: 'text' as const, text: err.message }], isError: true };
        }
        throw err;
      }
    },
  );

  server.tool(
    'codechat_reply',
    `Record your replies to review comments after making fixes. Returns immediately with the updated session (no browser). The reviewer sees the replies in the next round.

Always call this after addressing a review; do not call codechat_review just to submit replies. Each reply needs commentId and body. resolved defaults to true: set it to false when you are asking a question or did not apply the change (for example a suggestion whose original text no longer matches).`,
    {
      repoPath: z.string().describe('Absolute path to the git repository'),
      replies: z.array(z.object({
        commentId: z.string().describe('The id of the comment being addressed'),
        body: z.string().describe('What you did, or your question'),
        resolved: z.boolean().optional().describe('Mark as resolved (default: true). false for a question or a change you did not make.'),
      })).min(1).describe('One reply per comment you addressed.'),
      sessionId: z.string().optional().describe('Session to reply on. Usually not needed: defaults to the latest session of the repository.'),
    },
    async ({ repoPath, replies, sessionId }) => {
      try {
        const result = await recordReplies(repoPath, replies, sessionId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (err instanceof WorkflowError) {
          return { content: [{ type: 'text' as const, text: err.message }], isError: true };
        }
        throw err;
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
