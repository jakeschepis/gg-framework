import { describe, expect, it } from "vitest";
import { ProviderError, formatError, isUsageLimitError } from "./errors.js";

describe("isUsageLimitError", () => {
  it("matches the canonical usage-limit message", () => {
    expect(isUsageLimitError(new ProviderError("anthropic", "Claude usage limit reached"))).toBe(
      true,
    );
  });

  it("does not match a transient rate-limit error", () => {
    expect(
      isUsageLimitError(
        new ProviderError("anthropic", "rate_limit_error: Rate limited.", { statusCode: 429 }),
      ),
    ).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isUsageLimitError("Claude usage limit reached")).toBe(false);
  });
});

describe("formatError usage limit", () => {
  it("produces a clear usage-finished message with reset time", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const formatted = formatError(
      new ProviderError("anthropic", "Claude usage limit reached", {
        statusCode: 429,
        resetsAt,
      }),
    );
    expect(formatted.headline).toBe("Anthropic usage limit reached.");
    expect(formatted.message).toContain("Your Anthropic usage is finished.");
    expect(formatted.message).toContain("It resets at");
    expect(formatted.guidance).toContain("Try again once it's back.");
    expect(formatted.resetsAt).toBe(resetsAt);
  });

  it("omits the reset clause when no reset time is known", () => {
    const formatted = formatError(
      new ProviderError("anthropic", "Claude usage limit reached", { statusCode: 429 }),
    );
    expect(formatted.headline).toBe("Anthropic usage limit reached.");
    expect(formatted.message).toBe("Your Anthropic usage is finished.");
    expect(formatted.resetsAt).toBeUndefined();
  });
});
