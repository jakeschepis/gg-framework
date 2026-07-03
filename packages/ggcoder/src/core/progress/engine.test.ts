import { describe, expect, it } from "vitest";
import { awardCommits, awardPrompt, applyStreak, commitXp, streakMultiplier } from "./engine.js";
import { createEmptyProgress, dayKey } from "./store.js";
import type { ProgressFile, ScoredCommit } from "./types.js";

const T0 = Date.parse("2026-07-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function fresh(): ProgressFile {
  return createEmptyProgress(new Date(T0));
}

function commit(sha: string, lines: number): ScoredCommit {
  return { sha, patchId: `pid-${sha}`, linesChanged: lines };
}

describe("awardPrompt", () => {
  it("gives +10 for a normal prompt", () => {
    const { file, gained } = awardPrompt(fresh(), T0);
    expect(gained).toBe(10);
    expect(file.xp).toBe(10);
    expect(file.totals.prompts).toBe(1);
    expect(file.xpBySource.prompts).toBe(10);
  });

  it("diminishes to +2 after 15 prompts in a rolling hour", () => {
    let file = fresh();
    for (let i = 0; i < 15; i++) {
      file = awardPrompt(file, T0 + i * 1000).file;
    }
    const { gained } = awardPrompt(file, T0 + 16_000);
    expect(gained).toBe(2);
  });

  it("recovers full XP once old prompts age out of the hour", () => {
    let file = fresh();
    for (let i = 0; i < 15; i++) {
      file = awardPrompt(file, T0 + i * 1000).file;
    }
    const { gained } = awardPrompt(file, T0 + HOUR + 20_000);
    expect(gained).toBe(10);
  });

  it("tracks distinct projects by hash", () => {
    let file = fresh();
    file = awardPrompt(file, T0, "/a").file;
    file = awardPrompt(file, T0 + 1, "/b").file;
    file = awardPrompt(file, T0 + 2, "/a").file;
    expect(file.totals.projects).toHaveLength(2);
  });

  it("sets a fresh lastEvent nonce on every award", () => {
    const r1 = awardPrompt(fresh(), T0);
    const nonce1 = r1.file.lastEvent?.nonce;
    const r2 = awardPrompt(r1.file, T0 + 1000);
    expect(nonce1).toBeTruthy();
    expect(r2.file.lastEvent?.nonce).not.toBe(nonce1);
  });

  it("reports levelUp when crossing a boundary", () => {
    const file = fresh();
    file.xp = 300; // level 2 needs 303
    const { levelUp } = awardPrompt(file, T0);
    expect(levelUp).toEqual({ from: 1, to: 2, rankName: "Tinkerer" });
  });
});

describe("commitXp", () => {
  it("scales sub-linearly and caps at 100", () => {
    expect(commitXp(0)).toBe(20);
    expect(commitXp(25)).toBe(40); // 20 + √25×4
    expect(commitXp(400)).toBe(100); // capped
    expect(commitXp(1_000_000)).toBe(100);
  });
});

describe("awardCommits", () => {
  it("scores a commit by size", () => {
    const { file, gained } = awardCommits(fresh(), [commit("a", 25)], T0);
    expect(gained).toBe(40);
    expect(file.totals.commits).toBe(1);
    expect(file.totals.linesShipped).toBe(25);
    expect(file.xpBySource.commits).toBe(40);
  });

  it("dedupes by patch-id — revert/recommit earns 0", () => {
    const first = awardCommits(fresh(), [commit("a", 25)], T0);
    const second = awardCommits(first.file, [{ ...commit("b", 25), patchId: "pid-a" }], T0 + 1000);
    expect(second.gained).toBe(0);
    expect(second.file.totals.commits).toBe(1); // not even counted
  });

  it("caps XP-earning commits at 6 per rolling hour", () => {
    const commits = Array.from({ length: 8 }, (_, i) => commit(`c${i}`, 4));
    const { file, gained } = awardCommits(fresh(), commits, T0);
    expect(gained).toBe(6 * 28); // 20 + √4×4 = 28 each
    expect(file.totals.commits).toBe(8); // totals still count all
  });
});

describe("streaks", () => {
  it("multiplier tiers", () => {
    expect(streakMultiplier(1)).toBe(1);
    expect(streakMultiplier(3)).toBe(1.1);
    expect(streakMultiplier(7)).toBe(1.25);
    expect(streakMultiplier(14)).toBe(1.4);
    expect(streakMultiplier(30)).toBe(1.5);
  });

  it("increments on consecutive days and resets after a gap", () => {
    const file = fresh();
    applyStreak(file, T0);
    expect(file.streak.current).toBe(1);
    applyStreak(file, T0 + DAY);
    expect(file.streak.current).toBe(2);
    applyStreak(file, T0 + DAY + 1000); // same day — no change
    expect(file.streak.current).toBe(2);
    applyStreak(file, T0 + 4 * DAY); // gap
    expect(file.streak.current).toBe(1);
    expect(file.streak.best).toBe(2);
  });

  it("applies the multiplier to prompt XP", () => {
    const file = fresh();
    file.streak = { current: 6, best: 6, lastActiveDay: dayKey(new Date(T0 - DAY)) };
    const { gained } = awardPrompt(file, T0); // day 7 → ×1.25
    expect(gained).toBe(Math.round(10 * 1.25));
    expect(file.xpBySource.prompts).toBe(10);
    expect(file.xpBySource.streakBonus).toBe(gained - 10);
  });
});

describe("daily soft cap", () => {
  it("earns at 25% beyond 500 XP/day", () => {
    const file = fresh();
    file.rolling.dayXp = 500;
    const { gained } = awardPrompt(file, T0);
    expect(gained).toBe(Math.round(10 * 0.25));
  });

  it("splits an award straddling the cap", () => {
    const file = fresh();
    file.rolling.dayXp = 495;
    const { gained } = awardPrompt(file, T0); // 5 full + 5×0.25
    expect(gained).toBe(6);
  });

  it("resets on day rollover", () => {
    const file = fresh();
    file.rolling.dayXp = 500;
    const { gained } = awardPrompt(file, T0 + DAY);
    expect(gained).toBe(10);
  });
});
