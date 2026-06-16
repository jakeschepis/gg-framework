import { describe, expect, it } from "vitest";
import { createTerminalHistoryPrinter } from "./terminal-history.js";
import type { CompletedItem } from "./app-items.js";
import { loadTheme } from "./theme/theme.js";

const context = {
  theme: loadTheme("dark"),
  columns: 80,
  version: "0.0.0-test",
  model: "test-model",
  provider: "anthropic" as const,
  cwd: "/tmp/project",
};

function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

const HOOK = "Hook engaged — running an ideal review before finalizing.";
const ASSISTANT = "Done. Commented out the claude-fable-5 and claude-mythos-5 entries.";

describe("terminal history repaint duplication", () => {
  // Mirrors the real lifecycle: ONE printer instance lives in renderApp's
  // closure and is reused across the mount-time history-effect, mid-stream
  // flushes, and resize redraws. A duplicate row reaching scrollback twice
  // (without a screen clear in between) is the bug from the screenshot.
  it("does not re-print history on the mount-time history-effect after a flush", () => {
    let output = "";
    const printer = createTerminalHistoryPrinter();
    const write = (data: string) => {
      output += data;
    };

    // Turn finalizes: flush hook row + assistant row to scrollback.
    printer.print([{ kind: "ideal_hook", text: HOOK, tone: "review", id: "hook-1" }], context, {
      write,
      reason: "flush",
    });
    printer.print([{ kind: "assistant", text: ASSISTANT, id: "a-1" }], context, {
      write,
      reason: "flush",
    });

    // App's history-effect fires with the SAME items now folded into history
    // state (same ids). Reusing the same printer, this must be a no-op.
    const history: CompletedItem[] = [
      { kind: "banner", id: "banner" },
      { kind: "ideal_hook", text: HOOK, tone: "review", id: "hook-1" },
      { kind: "assistant", text: ASSISTANT, id: "a-1" },
    ];
    printer.print(history, context, { write, reason: "history-effect" });

    const scrollback = stripAnsi(output);
    expect(count(scrollback, HOOK)).toBe(1);
    expect(count(scrollback, ASSISTANT)).toBe(1);
  });

  // A force print (shrink-backfill repaints the transcript tail into space the
  // frame vacated) intentionally bypasses BOTH dedup layers — it must, because
  // it repaints into cleared space. This test pins that contract so we remember
  // force-printed rows are NOT protected: if the frame-shrink row math is wrong
  // and the space was not actually vacated, force repaint duplicates on screen.
  it("force print bypasses id-dedup (documents the unguarded repaint contract)", () => {
    let output = "";
    const printer = createTerminalHistoryPrinter();
    const write = (data: string) => {
      output += data;
    };

    const item: CompletedItem = { kind: "assistant", text: ASSISTANT, id: "a-1" };
    printer.print([item], context, { write, reason: "flush" });
    printer.print([item], context, { write, force: true, reason: "shrink-backfill" });

    // Same id, but force re-emits anyway — by design. Verification that a
    // force repaint is unconditionally trusted to land in vacated space.
    const scrollback = stripAnsi(output);
    expect(count(scrollback, ASSISTANT)).toBe(2);
  });
});
