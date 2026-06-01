import type { Message } from "@kenkaiiii/gg-ai";

/**
 * Loop-breaker hook — the mid-loop counterpart to the ideal review.
 *
 * Where the ideal review fires when the agent is about to STOP, the
 * loop-breaker fires when the agent is STUCK: repeating the same failing
 * action, hammering the same file, or degenerating into repeated output.
 * The decision is pure arithmetic over signals useAgentLoop already
 * collects, so the trigger itself costs nothing — only the (at most one)
 * injected message costs a round-trip.
 *
 * Two independent detectors per the research:
 *  - tool-call level: signature repeats / same-file edits / failures.
 *  - text level: a streamed block repeating verbatim (high-temp / stuck
 *    token degeneration), which signature hashing alone never catches.
 */

export interface LoopBreakStats {
  /** Failed tool calls in an unbroken streak (reset by any success). */
  consecutiveFailures: number;
  /** Highest repeat count for any single tool-call signature this run. */
  maxSignatureRepeats: number;
  /** Highest number of edits to any single file this run. */
  maxSameFileEdits: number;
  /** Whether streamed assistant text degenerated into repetition. */
  textRepetitionDetected: boolean;
}

export interface LoopBreakDecision {
  shouldBreak: boolean;
  reasons: string[];
}

const CONSECUTIVE_FAILURE_LIMIT = 3;
const SIGNATURE_REPEAT_LIMIT = 3;
const SAME_FILE_EDIT_LIMIT = 5;

export const LOOP_BREAK_PROMPT =
  "Stuck? You've repeated essentially the same action and it keeps failing or not advancing. " +
  "Stop and break the pattern. Read the latest error or result literally \u2014 not what you " +
  "expected it to say. Then question the assumption underneath your approach: the file, path, " +
  "API, command, or premise you've been treating as true may be wrong. Either try a " +
  "fundamentally different approach or, if you genuinely cannot make progress, stop and tell " +
  "the user what's blocking you and what you need. Do NOT repeat the previous attempt with minor " +
  "tweaks. Do not mention this note unless it changed your approach.";

/**
 * Stable signature for a tool call: name + canonicalized args. Key order is
 * normalized so semantically identical calls hash identically.
 */
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
  if (stats.maxSignatureRepeats >= SIGNATURE_REPEAT_LIMIT) {
    reasons.push(`identical tool call repeated ${stats.maxSignatureRepeats}x`);
  }
  if (stats.maxSameFileEdits >= SAME_FILE_EDIT_LIMIT) {
    reasons.push(`${stats.maxSameFileEdits} edits to the same file`);
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
