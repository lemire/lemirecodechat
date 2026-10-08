import { structuredPatch } from 'diff';
import type { Suggestion } from './types.js';

/** Split file content into lines, dropping the empty string after a trailing newline. */
export function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Build a suggestion replacing lines `line..endLine` (1-based, inclusive) of `content`.
 * The patch carries real file line numbers so it can be read (or applied) in context.
 */
export function buildSuggestion(
  filePath: string,
  content: string,
  line: number,
  endLine: number,
  replacement: string,
): Suggestion {
  const lines = splitLines(content);
  if (line < 1 || endLine < line || endLine > lines.length) {
    throw new Error(`Lines ${line}-${endLine} are outside ${filePath} (${lines.length} lines)`);
  }
  const original = lines.slice(line - 1, endLine).join('\n');
  const normalized = replacement.replace(/\r\n/g, '\n').replace(/\n$/, '');

  const { hunks } = structuredPatch(filePath, filePath, original + '\n', normalized + '\n', '', '', { context: 3 });
  const body = hunks.map((h) => {
    const offset = line - 1;
    return [`@@ -${h.oldStart + offset},${h.oldLines} +${h.newStart + offset},${h.newLines} @@`, ...h.lines].join('\n');
  });
  const patch = [`--- a/${filePath}`, `+++ b/${filePath}`, ...body].join('\n') + '\n';

  return { original, replacement: normalized, patch };
}
