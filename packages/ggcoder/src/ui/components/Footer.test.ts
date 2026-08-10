import { describe, expect, it } from "vitest";
import {
  doesFooterFitOnOneLine,
  getAutopilotFooterLabel,
  getFooterContextPercent,
  getFooterRightLength,
} from "./Footer.js";

describe("Footer route-aware context percentage", () => {
  it("uses the larger public window for API-key OpenAI routes", () => {
    expect(
      getFooterContextPercent("gpt-5.6-terra", 64_000, {
        provider: "openai",
      }),
    ).toBe(6);
  });

  it("uses the Codex product cap for OAuth OpenAI routes", () => {
    expect(
      getFooterContextPercent("gpt-5.6-terra", 64_000, {
        provider: "openai",
        accountId: "acct_123",
      }),
    ).toBe(24);
  });
});

describe("Footer autopilot segment", () => {
  it("labels the autopilot state", () => {
    expect(getAutopilotFooterLabel(true)).toBe("Auto on");
    expect(getAutopilotFooterLabel(false)).toBe("Auto off");
    expect(getAutopilotFooterLabel(undefined)).toBe("Auto off");
  });

  it("adds the segment plus its separator to the right-side width", () => {
    const base = {
      barWidth: 8,
      contextPct: 12,
      modelName: "Sonnet",
      planText: "Plan off",
      thinkingText: "Thinking off",
    };

    expect(getFooterRightLength({ ...base, autopilotText: "Auto on" })).toBe(
      getFooterRightLength({ ...base, autopilotText: "Auto off" }) - 1,
    );
  });

  it("budgets the wider off-label when no autopilot state is supplied", () => {
    const base = {
      barWidth: 8,
      contextPct: 12,
      modelName: "Sonnet",
      thinkingText: "Thinking off",
    };

    expect(getFooterRightLength(base)).toBe(
      getFooterRightLength({ ...base, autopilotText: "Auto off" }),
    );
  });

  it("counts the segment when deciding the one-line footer layout", () => {
    const base = {
      model: "claude-sonnet-5",
      tokensIn: 12_000,
      cwd: "/Users/dev/gg-framework",
      gitBranch: "main",
      planMode: false,
    };
    // Width chosen so the footer only fits once the 11-char "Auto off"
    // segment (separator + label) is taken out of the budget.
    const rightWithoutAutopilot =
      getFooterRightLength({
        barWidth: 8,
        contextPct: getFooterContextPercent(base.model, base.tokensIn),
        modelName: "Sonnet",
        planText: "Plan off",
        thinkingText: "Thinking off",
      }) - 11;
    const leftLen = "gg-framework".length + 2 + "main".length + 5;
    const tightColumns = leftLen + rightWithoutAutopilot + 2;

    expect(doesFooterFitOnOneLine({ ...base, columns: tightColumns })).toBe(false);
    expect(doesFooterFitOnOneLine({ ...base, columns: tightColumns + 11 })).toBe(true);
  });
});
