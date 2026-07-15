import { describe, expect, it } from "vitest";
import { evaluateLoopBreak, ToolCallProgressTracker } from "../../core/loop-breaker.js";
import { shouldRetainThinkingDelta } from "./useAgentLoop.js";

describe("useAgentLoop thinking display", () => {
  it("does not retain provider reasoning in chat transcript state", () => {
    expect(shouldRetainThinkingDelta()).toBe(false);
  });
});

describe("useAgentLoop loop-break tracking", () => {
  it("does not flag repeated background polling", () => {
    const tracker = new ToolCallProgressTracker();
    let repeatedNoProgressCalls = 0;

    for (let i = 0; i < 5; i++) {
      repeatedNoProgressCalls = tracker.record(
        "task_output",
        { id: "running-job" },
        "Process running\n(no new output)",
        false,
      );
    }

    expect(
      evaluateLoopBreak({
        consecutiveFailures: 0,
        repeatedNoProgressCalls,
        textRepetitionDetected: false,
      }).shouldBreak,
    ).toBe(false);
  });

  it("does not flag successful iterative edits to one file", () => {
    const tracker = new ToolCallProgressTracker();
    let repeatedNoProgressCalls = 0;

    for (let i = 0; i < 6; i++) {
      repeatedNoProgressCalls = tracker.record(
        "edit",
        { file_path: "src/app.ts", old_text: `before-${i}`, new_text: `after-${i}` },
        `diff-${i}`,
        false,
      );
    }

    expect(
      evaluateLoopBreak({
        consecutiveFailures: 0,
        repeatedNoProgressCalls,
        textRepetitionDetected: false,
      }).shouldBreak,
    ).toBe(false);
  });
});
