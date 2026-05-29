import { describe, expect, it } from "vitest";
import { createTerminalHistoryPrinter } from "./terminal-history.js";
import { splitAssistantStreamingText } from "./utils/assistant-stream-split.js";
import { stripDoneMarkers } from "../utils/plan-steps.js";
import type { CompletedItem } from "./app-items.js";
import { loadTheme } from "./theme/theme.js";

const context = {
  theme: loadTheme("dark"),
  columns: 80,
  version: "0.0.0-test",
  model: "test-model",
  provider: "openai" as const,
  cwd: "/tmp/project",
};

function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");
}

function printAll(items: CompletedItem[]): string {
  let out = "";
  const printer = createTerminalHistoryPrinter({
    stream: { write: () => true } as unknown as NodeJS.WriteStream,
  });
  printer.print(items, context, { write: (data) => (out += data) });
  return stripAnsi(out);
}

/**
 * Drive the same incremental-flush state machine App.tsx uses: as the response
 * streams in, flush completed paragraphs as (continuation) assistant items, then
 * finalize the trailing block. The reassembled scrollback must byte-match the
 * whole response printed as a single assistant item — otherwise progressive
 * flushing would corrupt the rendered history.
 */
function printStreamed(full: string, makeId: () => string): string {
  const items: CompletedItem[] = [];
  let flushedChars = 0;
  // Simulate streaming growth one character at a time (covers every boundary).
  for (let len = 1; len <= full.length; len++) {
    const unflushed = full.slice(flushedChars, len);
    const split = splitAssistantStreamingText(unflushed);
    if (split.flushedText.length > 0) {
      items.push({
        kind: "assistant",
        text: stripDoneMarkers(split.flushedText),
        continuation: flushedChars > 0,
        id: makeId(),
      });
      flushedChars += split.flushedText.length;
    }
  }
  // Finalize the trailing block (message_done).
  const tail = full.slice(flushedChars);
  if (tail.length > 0) {
    items.push({
      kind: "assistant",
      text: stripDoneMarkers(tail),
      continuation: flushedChars > 0,
      id: makeId(),
    });
  }
  return printAll(items);
}

describe("assistant streamed-flush parity", () => {
  it("reassembled scrollback matches the whole response for multi-paragraph text", () => {
    const full =
      "First paragraph of the answer.\n\nSecond paragraph with detail.\n\nFinal paragraph wraps it up.";
    let n = 0;
    const makeId = () => `chunk-${n++}`;
    const whole = printAll([{ kind: "assistant", text: full, id: "whole" }]);
    expect(printStreamed(full, makeId)).toBe(whole);
  });

  it("reassembled scrollback matches the whole response across a code fence", () => {
    const full = "Here is the fix:\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\nThat completes it.";
    let n = 0;
    const makeId = () => `chunk-${n++}`;
    const whole = printAll([{ kind: "assistant", text: full, id: "whole" }]);
    expect(printStreamed(full, makeId)).toBe(whole);
  });

  it("reassembled scrollback matches for a single-paragraph response (no flush)", () => {
    const full = "A single paragraph response that never hits a blank line boundary.";
    let n = 0;
    const makeId = () => `chunk-${n++}`;
    const whole = printAll([{ kind: "assistant", text: full, id: "whole" }]);
    expect(printStreamed(full, makeId)).toBe(whole);
  });
});
