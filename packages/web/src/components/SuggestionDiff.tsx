import { useMemo } from 'react';
import { diffLines } from 'diff';

interface SuggestionDiffProps {
  original: string;
  replacement: string;
}

/** Line-level view of a suggested change: removed lines, then added lines, with shared lines as context. */
export function SuggestionDiff({ original, replacement }: SuggestionDiffProps) {
  const rows = useMemo(() => {
    const out: { kind: 'del' | 'ins' | 'same'; text: string }[] = [];
    for (const part of diffLines(original + '\n', replacement + '\n')) {
      const kind = part.added ? 'ins' : part.removed ? 'del' : 'same';
      const lines = part.value.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      for (const text of lines) out.push({ kind, text });
    }
    return out;
  }, [original, replacement]);

  return (
    <div className="suggestion-diff" style={{ color: 'var(--color-text-primary)' }}>
      {rows.map((row, i) => (
        <div key={i} className={`suggestion-diff-line ${row.kind}`}>
          {row.text || ' '}
        </div>
      ))}
    </div>
  );
}
