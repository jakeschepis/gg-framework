import { describe, expect, it } from "vitest";
import { isTerminalFocusSequence, stripTerminalFocusSequences } from "./terminal-input.js";

describe("terminal focus-report input sanitizing", () => {
  it("removes normal and ESC-less focus reports", () => {
    expect(stripTerminalFocusSequences("\x1b[I\x1b[O\x1b[I")).toBe("");
    expect(stripTerminalFocusSequences("[I[O[I")).toBe("");
    expect(stripTerminalFocusSequences("a[I\x1b[Ob")).toBe("a[Ib");
  });

  it("detects chunks that are only focus reports", () => {
    expect(isTerminalFocusSequence("[I[O[I")).toBe(true);
    expect(isTerminalFocusSequence("\x1b[I")).toBe(true);
    expect(isTerminalFocusSequence("model")).toBe(false);
  });
});
