import { memo } from "react";

interface TerminalFrameProps {
  /** Array of HTML-safe row strings emitted by the backend web theme. */
  rows: string[];
}

/**
 * Renders the terminal grid.
 *
 * Each row is set via dangerouslySetInnerHTML — this is safe because the
 * backend HTML-escapes all dynamic text before wrapping in
 * `<span class="tc tc-{color}">` segments.
 *
 * Empty rows still produce a visible line (via `&nbsp;`) so the terminal
 * grid maintains its vertical rhythm.
 */
export const TerminalFrame = memo(function TerminalFrame({
  rows,
}: TerminalFrameProps) {
  return (
    <div className="terminal-frame">
      {rows.map((row, i) => (
        <div
          key={i}
          className="term-row"
          dangerouslySetInnerHTML={{ __html: row || "&nbsp;" }}
        />
      ))}
    </div>
  );
});
