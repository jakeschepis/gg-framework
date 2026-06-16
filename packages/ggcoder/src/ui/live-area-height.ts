import stringWidth from "string-width";
import type { CompletedItem } from "./app-items.js";
import { isPanelReplacedToolItem } from "./app-items.js";

/**
 * Width the assistant/streaming markdown body wraps to, mirroring
 * AssistantMessage's content box: columns - RESPONSE_LEFT_PADDING(1) -
 * PREFIX_WIDTH(2) - RESPONSE_RIGHT_GUARD(1).
 */
function bodyWidth(columns: number): number {
  return Math.max(10, columns - 4);
}

/**
 * Cheap, deterministic estimate of how many terminal rows a block of text
 * occupies once wrapped to `width`. Biased high (uses display width and counts
 * at least one row per source line) so the live-area clamp never UNDER-counts
 * and lets the frame overflow past the terminal height.
 */
export function estimateWrappedRows(text: string, columns: number): number {
  const width = bodyWidth(columns);
  return text
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(stringWidth(line) / width)), 0);
}

const THINKING_HEADER_ROWS = 2;
// Per-block decoration not captured by the wrapped body: the top-spacing margin
// plus the response prefix line allowance.
const BLOCK_OVERHEAD_ROWS = 1;
// Allowance for non-text live rows (tool headers, step markers, info/error
// lines). Most render a single visible row and are flushed to scrollback
// quickly. This estimate is intentionally NOT biased high: an over-count fixes
// the live area to the full budget while the real content is shorter, which
// bottom-anchors that content and leaves a block of blank rows above it (most
// visible when slash-command info rows linger before they flush). An
// under-count is harmless — the patched Ink renderer's clipFrameToTerminalHeight
// caps the whole frame at rows-2 (below the jump-to-top threshold) using the
// REAL rendered height, so it is the authoritative overflow backstop.
const NON_TEXT_ROW_ESTIMATE = 1;

/**
 * Estimate the total rendered height (in terminal rows) of the live area:
 * every live item plus the in-flight streaming block. Each text block is
 * individually capped at `perItemBudget` because AssistantMessage/Markdown
 * truncate to that height, but their SUM is what can overflow the terminal —
 * which is exactly what this measures.
 */
export function estimateLiveAreaRows({
  liveItems,
  streamingText,
  columns,
  perItemBudget,
}: {
  liveItems: readonly CompletedItem[];
  streamingText: string;
  columns: number;
  perItemBudget: number;
}): number {
  let rows = 0;
  for (const item of liveItems) {
    if (item.kind === "assistant") {
      const textRows = item.text.trim().length > 0 ? estimateWrappedRows(item.text, columns) : 0;
      const thinkingRows = item.thinking ? THINKING_HEADER_ROWS : 0;
      rows += Math.min(textRows, perItemBudget) + thinkingRows + BLOCK_OVERHEAD_ROWS;
    } else if (
      item.kind === "tombstone" ||
      item.kind === "banner" ||
      (item.kind === "plan_transition" && !item.active) ||
      isPanelReplacedToolItem(item)
    ) {
      // These rows render outside this pane or as null (panel-replaced tools,
      // inactive plan transitions), so they contribute zero live-area rows.
      continue;
    } else {
      rows += NON_TEXT_ROW_ESTIMATE;
    }
  }
  const trimmedStreaming = streamingText.trim();
  if (trimmedStreaming.length > 0) {
    rows +=
      Math.min(estimateWrappedRows(streamingText, columns), perItemBudget) + BLOCK_OVERHEAD_ROWS;
  }
  return rows;
}

/**
 * Decide whether the live area must be hard-clamped to `liveAreaBudget` rows.
 * Returns the clamp height when the estimated content would overflow the
 * budget (so the bottom-anchored container clips the oldest rows and keeps the
 * Ink-rendered frame strictly below the terminal height), or `undefined` when
 * the content fits and the area should stay compact (no reserved blank rows).
 */
export function getLiveAreaClampRows({
  liveItems,
  streamingText,
  columns,
  liveAreaBudget,
}: {
  liveItems: readonly CompletedItem[];
  streamingText: string;
  columns: number;
  liveAreaBudget: number;
}): number | undefined {
  const estimated = estimateLiveAreaRows({
    liveItems,
    streamingText,
    columns,
    perItemBudget: liveAreaBudget,
  });
  return estimated > liveAreaBudget ? liveAreaBudget : undefined;
}
