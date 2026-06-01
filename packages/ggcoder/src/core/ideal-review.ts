import type { Message } from "@kenkaiiii/gg-ai";

export interface IdealReviewStats {
  changedLines: number;
  toolCalls: number;
  toolFailures: number;
  turns: number;
  writeCalls: number;
  editCalls: number;
  bashCalls: number;
}

export interface IdealReviewDecision {
  shouldReview: boolean;
  score: number;
  reasons: string[];
}

export const IDEAL_REVIEW_PROMPT =
  "Ideal? Review the actual work against the user's request before the final response. " +
  "Is it simple, focused, correct, and aligned? Did you over-edit, leave TODOs, miss an obvious " +
  "case the request called for, or introduce risk? Judge this by reading the code you changed \u2014 " +
  "do NOT run builds, typechecks, linters, or test suites now; that happens at commit time via " +
  "/commit. If anything is wrong, fix it now. If everything is good, respond with the final " +
  "answer only; do not mention this ideal review unless it changed the work.";

const RISKY_TOOL_NAMES = new Set(["bash", "write", "edit"]);

export function evaluateIdealReview(stats: IdealReviewStats): IdealReviewDecision {
  const reasons: string[] = [];
  let score = 0;

  if (stats.changedLines >= 120) {
    score += 2;
    reasons.push(`${stats.changedLines} changed lines`);
  } else if (stats.changedLines >= 60) {
    score += 1;
    reasons.push(`${stats.changedLines} changed lines`);
  }

  if (stats.toolCalls >= 8) {
    score += 1;
    reasons.push(`${stats.toolCalls} tool calls`);
  }

  if (stats.writeCalls + stats.editCalls >= 4) {
    score += 2;
    reasons.push(`${stats.writeCalls + stats.editCalls} file mutation calls`);
  } else if (stats.writeCalls + stats.editCalls >= 2) {
    score += 1;
    reasons.push(`${stats.writeCalls + stats.editCalls} file mutation calls`);
  }

  if (stats.bashCalls > 0 && stats.writeCalls + stats.editCalls > 0) {
    score += 1;
    reasons.push("shell command plus file mutation");
  }

  if (stats.toolFailures > 0) {
    score += 2;
    reasons.push(`${stats.toolFailures} failed tool calls`);
  }

  if (stats.turns >= 6) {
    score += 1;
    reasons.push(`${stats.turns} agent turns`);
  }

  return { shouldReview: score >= 4, score, reasons };
}

export function buildIdealReviewMessage(reasons: readonly string[]): Message {
  const reasonText = reasons.length > 0 ? ` Triggered because: ${reasons.join(", ")}.` : "";
  return {
    role: "user",
    content: `${IDEAL_REVIEW_PROMPT}${reasonText}`,
  };
}

export function shouldCountAsRiskyTool(toolName: string): boolean {
  return RISKY_TOOL_NAMES.has(toolName);
}
