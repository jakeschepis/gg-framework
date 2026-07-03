import { describe, expect, it } from "vitest";
import { MAX_LEVEL, levelForXp, rankForLevel, rankLadder, xpForLevel } from "./ranks.js";

describe("xpForLevel", () => {
  it("matches the 100 × N^1.6 curve", () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(303);
    expect(xpForLevel(10)).toBe(3981);
    expect(xpForLevel(50)).toBe(52282);
  });

  it("is strictly increasing", () => {
    for (let n = 2; n <= MAX_LEVEL; n++) {
      expect(xpForLevel(n)).toBeGreaterThan(xpForLevel(n - 1));
    }
  });
});

describe("levelForXp", () => {
  it("returns 1 at 0 XP", () => {
    expect(levelForXp(0)).toBe(1);
  });

  it("crosses level boundaries exactly", () => {
    expect(levelForXp(302)).toBe(1);
    expect(levelForXp(303)).toBe(2);
    expect(levelForXp(3981)).toBe(10);
  });

  it("caps at MAX_LEVEL", () => {
    expect(levelForXp(10_000_000)).toBe(MAX_LEVEL);
  });
});

describe("rankForLevel", () => {
  it("names the tier boundaries correctly", () => {
    expect(rankForLevel(1).name).toBe("Lurker");
    expect(rankForLevel(5).name).toBe("Scripter");
    expect(rankForLevel(6).name).toBe("Patcher");
    expect(rankForLevel(20).name).toBe("Architect");
    expect(rankForLevel(25).name).toBe("Netrunner");
    expect(rankForLevel(50).name).toBe("Singularity");
  });

  it("assigns tiers 1–10", () => {
    expect(rankForLevel(1).tier).toBe(1);
    expect(rankForLevel(5).tier).toBe(1);
    expect(rankForLevel(6).tier).toBe(2);
    expect(rankForLevel(50).tier).toBe(10);
  });

  it("clamps out-of-range levels", () => {
    expect(rankForLevel(0).level).toBe(1);
    expect(rankForLevel(99).level).toBe(50);
  });
});

describe("rankLadder", () => {
  it("has 50 unique names with increasing xpRequired", () => {
    const ladder = rankLadder();
    expect(ladder).toHaveLength(50);
    expect(new Set(ladder.map((r) => r.name)).size).toBe(50);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].xpRequired).toBeGreaterThan(ladder[i - 1].xpRequired);
    }
  });
});
