export type {
  Session,
  FileSummary,
  Comment,
  Suggestion,
  SkippedFile,
  ReviewResult,
  ServerMessage,
  ClientMessage,
} from 'lemirecodechat';

/** Whether a comment or draft spans multiple lines. */
export function isLineRange(item: { line: number; endLine?: number }): boolean {
  return item.endLine !== undefined && item.endLine !== item.line;
}
