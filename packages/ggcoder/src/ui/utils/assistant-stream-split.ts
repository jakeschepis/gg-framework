export interface AssistantStreamSplit {
  flushedText: string;
  remainingText: string;
}

function isInsideCodeFence(text: string): boolean {
  const fenceMatches = text.match(/^\s*(`{3,}|~{3,})/gm);
  return (fenceMatches?.length ?? 0) % 2 === 1;
}

/**
 * Decide how much of the in-flight assistant text can be flushed to terminal
 * scrollback while streaming, keeping the trailing in-progress block live.
 *
 * Flushing progressively (instead of dumping the whole response at the end)
 * keeps the live region small so it never has to scroll the full response into
 * scrollback in one shot — that single large write is what makes the TUI
 * "jump up" when the agent finishes.
 *
 * Splits ONLY at paragraph boundaries (blank lines) that sit OUTSIDE code
 * fences, and never trims interior whitespace, so each flushed chunk is a
 * self-contained set of Markdown blocks that renders identically whether shown
 * alone in history or as part of the whole response. (An earlier version split
 * mid-sentence and trimmed whitespace, which broke live/history parity.)
 *
 * Guarantees `flushedText + remainingText === text`.
 */
export function splitAssistantStreamingText(text: string): AssistantStreamSplit {
  const boundary = /\n[ \t]*\n/g;
  let best = -1;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const boundaryEnd = match.index + match[0].length;
    // Keep the trailing block live until it too ends in a blank line.
    if (boundaryEnd >= text.length) break;
    // Never split inside an open code fence — the chunk would render as broken
    // Markdown (unterminated fence) in history.
    if (isInsideCodeFence(text.slice(0, boundaryEnd))) continue;
    best = boundaryEnd;
  }
  if (best <= 0) return { flushedText: "", remainingText: text };
  return { flushedText: text.slice(0, best), remainingText: text.slice(best) };
}
