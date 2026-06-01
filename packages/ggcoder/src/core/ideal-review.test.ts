import { describe, expect, it } from "vitest";
import { buildIdealReviewMessage, evaluateIdealReview } from "./ideal-review.js";

describe("evaluateIdealReview", () => {
  it("skips tiny text-only changes", () => {
    const decision = evaluateIdealReview({
      changedLines: 2,
      toolCalls: 2,
      toolFailures: 0,
      turns: 1,
      writeCalls: 0,
      editCalls: 1,
      bashCalls: 0,
    });

    expect(decision.shouldReview).toBe(false);
    expect(decision.score).toBeLessThan(4);
  });

  it("triggers for broad file mutation work before final response", () => {
    const decision = evaluateIdealReview({
      changedLines: 135,
      toolCalls: 9,
      toolFailures: 0,
      turns: 3,
      writeCalls: 1,
      editCalls: 3,
      bashCalls: 1,
    });

    expect(decision.shouldReview).toBe(true);
    expect(decision.reasons).toContain("135 changed lines");
    expect(decision.reasons).toContain("4 file mutation calls");
  });

  it("triggers for failed tool recovery even with smaller diffs", () => {
    const decision = evaluateIdealReview({
      changedLines: 42,
      toolCalls: 8,
      toolFailures: 1,
      turns: 2,
      writeCalls: 0,
      editCalls: 2,
      bashCalls: 1,
    });

    expect(decision.shouldReview).toBe(true);
  });
});

describe("buildIdealReviewMessage", () => {
  it("asks the model to review and fix before the final answer", () => {
    const message = buildIdealReviewMessage(["120 changed lines"]);

    expect(message.role).toBe("user");
    expect(message.content).toContain("Ideal?");
    expect(message.content).toContain("before the final response");
    expect(message.content).toContain("fix it now");
    expect(message.content).toContain("120 changed lines");
  });

  it("defers builds/typechecks/tests to commit time instead of running them now", () => {
    const message = buildIdealReviewMessage([]);

    expect(message.content).toContain("do NOT run builds, typechecks, linters, or test suites now");
    expect(message.content).toContain("/commit");
  });
});
