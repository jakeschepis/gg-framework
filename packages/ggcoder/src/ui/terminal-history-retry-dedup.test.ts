import { describe, expect, it } from "vitest";
import { createTerminalHistoryPrinter } from "./terminal-history.js";
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

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

const PARAGRAPH = "No email tools — removed the open my email and reply example.";

describe("terminal history retry de-duplication", () => {
  // Reproduces the reported bug: while streaming a large response, the agent
  // loop hits a transient stall/overload and emits a `retry`. The stream
  // restarts from scratch and re-emits the same leading paragraphs. The
  // progressive mid-stream flush re-flushes those paragraphs with FRESH ids
  // (because `flushedChars` resets when streamingText goes empty on retry).
  // The printer dedupes by id only, so each re-flush prints the identical
  // paragraph again — N retries => N+1 stacked copies in scrollback.
  it("prints identical assistant text once even when re-flushed with new ids across retries", () => {
    let output = "";
    const printer = createTerminalHistoryPrinter();
    const write = (data: string) => {
      output += data;
    };

    // Initial stream flushes the paragraph (id from first attempt).
    printer.print([{ kind: "assistant", text: PARAGRAPH, id: "ui-1" }], context, { write });

    // Retry 1 + Retry 2: provider re-streams the SAME paragraph; the
    // progressive-flush effect emits it again with new ids each time.
    printer.print([{ kind: "assistant", text: PARAGRAPH, id: "ui-2" }], context, { write });
    printer.print([{ kind: "assistant", text: PARAGRAPH, id: "ui-3" }], context, { write });

    // Final successful turn flushes the whole response (yet another id).
    printer.print([{ kind: "assistant", text: PARAGRAPH, id: "ui-4" }], context, { write });

    const scrollback = stripAnsi(output);
    expect(count(scrollback, PARAGRAPH)).toBe(1);
  });

  it("still prints genuinely distinct assistant paragraphs", () => {
    let output = "";
    const printer = createTerminalHistoryPrinter();
    const write = (data: string) => {
      output += data;
    };

    const items: CompletedItem[] = [
      { kind: "assistant", text: "First paragraph of the answer.", id: "ui-1" },
      { kind: "assistant", text: "Second distinct paragraph.", id: "ui-2" },
    ];
    printer.print(items, context, { write });

    const scrollback = stripAnsi(output);
    expect(count(scrollback, "First paragraph of the answer.")).toBe(1);
    expect(count(scrollback, "Second distinct paragraph.")).toBe(1);
  });
});
