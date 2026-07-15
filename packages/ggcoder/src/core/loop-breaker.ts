import type { Message } from "@kenkaiiii/gg-ai";

/**
 * Loop-breaker hook — the mid-loop counterpart to the ideal review.
 *
 * Where the ideal review fires when the agent is about to STOP, the
 * loop-breaker fires only on high-confidence evidence that the agent is
 * STUCK: a failure streak, the same call returning the same result repeatedly,
 * or degenerate repeated output.
 *
 * Successful edits to one file are progress, not a loop. Repeated calls are
 * counted only while consecutive and only when their result is unchanged;
 * expected polling/wait calls are excluded. This avoids interrupting healthy
 * long-running commands and iterative edits.
 */

export interface LoopBreakStats {
  /** Failed tool calls in an unbroken streak (reset by any success). */
  consecutiveFailures: number;
  /** Consecutive identical non-polling calls whose result did not change. */
  repeatedNoProgressCalls: number;
  /** Whether streamed assistant text degenerated into repetition. */
  textRepetitionDetected: boolean;
}

export interface LoopBreakDecision {
  shouldBreak: boolean;
  reasons: string[];
}

const CONSECUTIVE_FAILURE_LIMIT = 3;
const NO_PROGRESS_REPEAT_LIMIT = 3;

export const LOOP_BREAK_PROMPT =
  "Stuck? You've repeated essentially the same action and it keeps failing or not advancing. " +
  "Stop and break the pattern. Read the latest error or result literally \u2014 not what you " +
  "expected it to say. Then question the assumption underneath your approach: the file, path, " +
  "API, command, or premise you've been treating as true may be wrong. Either try a " +
  "fundamentally different approach or, if you genuinely cannot make progress, stop and tell " +
  "the user what's blocking you and what you need. Do NOT repeat the previous attempt with minor " +
  "tweaks. Do not mention this note unless it changed your approach.";

/** Stable signature for a tool call: name + canonicalized args. */
export function toolCallSignature(name: string, args: unknown): string {
  return `${name}\u0000${canonicalize(args)}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

const EXPECTED_REPEAT_TOOLS = new Set(["task_output", "wait_agent", "list_agents"]);

function isExpectedRepeat(name: string, args: unknown): boolean {
  if (EXPECTED_REPEAT_TOOLS.has(name)) return true;
  if (name !== "bash" || args === null || typeof args !== "object") return false;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" && /^(?:\s*sleep\s+\S+\s*;?\s*)+$/.test(command);
}

/**
 * Tracks only a currently repeating, unchanged tool outcome. Different calls,
 * changed output, and explicit polling/wait tools all prove enough movement to
 * reset the streak. One instance is used per agent run.
 */
export class ToolCallProgressTracker {
  private lastSignature: string | undefined;
  private lastResult: string | undefined;
  private lastWasError: boolean | undefined;
  private repeatCount = 0;

  record(name: string, args: unknown, result: string, isError: boolean): number {
    if (isExpectedRepeat(name, args)) {
      this.resetRepetition();
      return 0;
    }

    const signature = toolCallSignature(name, args);
    if (
      signature === this.lastSignature &&
      result === this.lastResult &&
      isError === this.lastWasError
    ) {
      this.repeatCount += 1;
    } else {
      this.lastSignature = signature;
      this.lastResult = result;
      this.lastWasError = isError;
      this.repeatCount = 1;
    }
    return this.repeatCount;
  }

  reset(): void {
    this.resetRepetition();
  }

  private resetRepetition(): void {
    this.lastSignature = undefined;
    this.lastResult = undefined;
    this.lastWasError = undefined;
    this.repeatCount = 0;
  }
}

const TEXT_REPETITION_MIN_LENGTH = 40;
const TEXT_REPETITION_MIN_REPEATS = 3;
const TEXT_REPETITION_TAIL = 4096;

/**
 * Detects verbatim repetition at the tail of streamed text — the model
 * looping on a phrase/block. Scans candidate block lengths and checks how
 * many times the trailing block repeats consecutively. Cheap: bounded to a
 * fixed tail window.
 */
export function detectTextRepetition(text: string): boolean {
  if (text.length < TEXT_REPETITION_MIN_LENGTH * TEXT_REPETITION_MIN_REPEATS) {
    return false;
  }
  const tail = text.slice(-TEXT_REPETITION_TAIL);
  const maxBlock = Math.floor(tail.length / TEXT_REPETITION_MIN_REPEATS);
  for (let block = TEXT_REPETITION_MIN_LENGTH; block <= maxBlock; block++) {
    const unit = tail.slice(tail.length - block);
    let repeats = 1;
    let offset = tail.length - block * 2;
    while (offset >= 0 && tail.slice(offset, offset + block) === unit) {
      repeats++;
      offset -= block;
    }
    if (repeats >= TEXT_REPETITION_MIN_REPEATS) return true;
  }
  return false;
}

export function evaluateLoopBreak(stats: LoopBreakStats): LoopBreakDecision {
  const reasons: string[] = [];

  if (stats.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
    reasons.push(`${stats.consecutiveFailures} consecutive failed tool calls`);
  }
  if (stats.repeatedNoProgressCalls >= NO_PROGRESS_REPEAT_LIMIT) {
    reasons.push(`identical tool call returned the same result ${stats.repeatedNoProgressCalls}x`);
  }
  if (stats.textRepetitionDetected) {
    reasons.push("repeated output detected");
  }

  return { shouldBreak: reasons.length > 0, reasons };
}

export function buildLoopBreakMessage(reasons: readonly string[]): Message {
  const reasonText = reasons.length > 0 ? ` Triggered because: ${reasons.join(", ")}.` : "";
  return {
    role: "user",
    content: `${LOOP_BREAK_PROMPT}${reasonText}`,
  };
}
