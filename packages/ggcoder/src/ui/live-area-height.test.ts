import { describe, expect, it } from "vitest";
import {
  estimateWrappedRows,
  estimateLiveAreaRows,
  getLiveAreaClampRows,
} from "./live-area-height.js";
import type { CompletedItem } from "./app-items.js";

const COLUMNS = 80;

function assistant(id: string, lines: number): CompletedItem {
  return {
    kind: "assistant",
    id,
    text: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"),
  };
}

describe("estimateWrappedRows", () => {
  it("counts one row per short source line", () => {
    expect(estimateWrappedRows("a\nb\nc", COLUMNS)).toBe(3);
  });

  it("counts wrapped rows for lines wider than the body width", () => {
    // body width = columns - 4 = 76; a 200-char line wraps to ceil(200/76) = 3.
    expect(estimateWrappedRows("x".repeat(200), COLUMNS)).toBe(3);
  });
});

describe("estimateLiveAreaRows", () => {
  it("sums per-block heights, capping each block at the per-item budget", () => {
    const rows = estimateLiveAreaRows({
      liveItems: [assistant("a1", 40), assistant("a2", 40)],
      streamingText: "",
      columns: COLUMNS,
      perItemBudget: 18,
    });
    // Each block capped at 18 + 1 overhead => 2 * 19 = 38.
    expect(rows).toBe(38);
  });

  it("includes the in-flight streaming block", () => {
    const rows = estimateLiveAreaRows({
      liveItems: [],
      streamingText: Array.from({ length: 40 }, (_, i) => `s ${i}`).join("\n"),
      columns: COLUMNS,
      perItemBudget: 18,
    });
    expect(rows).toBe(19);
  });
});

describe("getLiveAreaClampRows", () => {
  it("clamps to the budget when stacked blocks would overflow it", () => {
    expect(
      getLiveAreaClampRows({
        liveItems: [assistant("a1", 40), assistant("a2", 40)],
        streamingText: "",
        columns: COLUMNS,
        liveAreaBudget: 18,
      }),
    ).toBe(18);
  });

  it("stays compact (no clamp) when content fits the budget", () => {
    expect(
      getLiveAreaClampRows({
        liveItems: [assistant("a1", 3)],
        streamingText: "",
        columns: COLUMNS,
        liveAreaBudget: 18,
      }),
    ).toBeUndefined();
  });

  it("stays compact when the live area is empty", () => {
    expect(
      getLiveAreaClampRows({
        liveItems: [],
        streamingText: "",
        columns: COLUMNS,
        liveAreaBudget: 18,
      }),
    ).toBeUndefined();
  });
});
