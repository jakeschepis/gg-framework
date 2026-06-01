import { describe, expect, it } from "vitest";
import {
  buildLoopBreakMessage,
  detectTextRepetition,
  evaluateLoopBreak,
  toolCallSignature,
} from "./loop-breaker.js";

describe("toolCallSignature", () => {
  it("is stable regardless of key order in args", () => {
    const a = toolCallSignature("edit", { file_path: "a.ts", old: "x", new: "y" });
    const b = toolCallSignature("edit", { new: "y", old: "x", file_path: "a.ts" });
    expect(a).toBe(b);
  });

  it("differs when the tool name differs", () => {
    expect(toolCallSignature("read", { file_path: "a.ts" })).not.toBe(
      toolCallSignature("write", { file_path: "a.ts" }),
    );
  });

  it("differs when args differ", () => {
    expect(toolCallSignature("read", { file_path: "a.ts" })).not.toBe(
      toolCallSignature("read", { file_path: "b.ts" }),
    );
  });

  it("handles non-object args without throwing", () => {
    expect(() => toolCallSignature("bash", "ls -la")).not.toThrow();
    expect(toolCallSignature("bash", "ls")).toBe(toolCallSignature("bash", "ls"));
  });
});

describe("detectTextRepetition", () => {
  it("returns false for ordinary varied prose", () => {
    const text =
      "I read the config file, then updated the handler, ran the tests, and verified the output looks correct now.";
    expect(detectTextRepetition(text)).toBe(false);
  });

  it("detects a long block repeated consecutively at the tail", () => {
    const block = "ERROR: could not resolve module './missing'\n";
    expect(detectTextRepetition(block.repeat(6))).toBe(true);
  });

  it("does not trip on a block repeated only twice", () => {
    const block = "Let me try a slightly different approach here.\n";
    expect(detectTextRepetition(block.repeat(2))).toBe(false);
  });

  it("ignores short empty input", () => {
    expect(detectTextRepetition("")).toBe(false);
    expect(detectTextRepetition("ok")).toBe(false);
  });
});

describe("evaluateLoopBreak", () => {
  it("does not break on healthy progress", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 1,
      maxSignatureRepeats: 1,
      maxSameFileEdits: 2,
      textRepetitionDetected: false,
    });
    expect(decision.shouldBreak).toBe(false);
    expect(decision.reasons).toHaveLength(0);
  });

  it("breaks after repeated consecutive tool failures", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 3,
      maxSignatureRepeats: 1,
      maxSameFileEdits: 1,
      textRepetitionDetected: false,
    });
    expect(decision.shouldBreak).toBe(true);
    expect(decision.reasons.join(" ")).toContain("3 consecutive failed tool calls");
  });

  it("breaks when the identical tool call is repeated", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 0,
      maxSignatureRepeats: 3,
      maxSameFileEdits: 1,
      textRepetitionDetected: false,
    });
    expect(decision.shouldBreak).toBe(true);
    expect(decision.reasons.join(" ")).toContain("identical tool call");
  });

  it("breaks when one file is edited many times in a run", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 0,
      maxSignatureRepeats: 1,
      maxSameFileEdits: 5,
      textRepetitionDetected: false,
    });
    expect(decision.shouldBreak).toBe(true);
    expect(decision.reasons.join(" ")).toContain("5 edits to the same file");
  });

  it("breaks when streaming text degenerates into repetition", () => {
    const decision = evaluateLoopBreak({
      consecutiveFailures: 0,
      maxSignatureRepeats: 1,
      maxSameFileEdits: 1,
      textRepetitionDetected: true,
    });
    expect(decision.shouldBreak).toBe(true);
    expect(decision.reasons.join(" ")).toContain("repeated output");
  });
});

describe("buildLoopBreakMessage", () => {
  it("tells the model to stop, re-read the evidence, and question its assumption", () => {
    const message = buildLoopBreakMessage(["3 consecutive failed tool calls"]);
    expect(message.role).toBe("user");
    expect(message.content).toContain("Stuck?");
    expect(message.content).toContain("assumption");
    expect(message.content).toContain("3 consecutive failed tool calls");
  });

  it("permits escalating to the user as a last resort", () => {
    const message = buildLoopBreakMessage([]);
    expect(message.content).toContain("tell the user");
    expect(message.content).not.toContain("Triggered because");
  });

  it("does not instruct the model to narrate the note", () => {
    const message = buildLoopBreakMessage(["identical tool call repeated 3x"]);
    const content = message.content as string;
    expect(content).toContain("Triggered because");
    expect(content.toLowerCase()).toContain("do not mention this note");
  });
});
