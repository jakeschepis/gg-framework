// Pure XP engine — all functions take a ProgressFile and a `now`, mutate a copy, and
// return the gain. No I/O here; the store handles persistence.

import crypto from "node:crypto";
import { levelForXp, rankForLevel } from "./ranks.js";
import { dayKey } from "./store.js";
import type { LevelUpEvent, ProgressFile, ScoredCommit } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
const PROMPT_XP = 10;
const PROMPT_XP_DIMINISHED = 2;
const PROMPTS_PER_HOUR_FULL = 15;
const COMMIT_BASE_XP = 20;
const COMMIT_SIZE_XP_CAP = 80;
const COMMITS_PER_HOUR = 6;
const DAILY_SOFT_CAP = 500;
const DAILY_OVERCAP_FACTOR = 0.25;

export interface AwardResult {
  file: ProgressFile;
  gained: number;
  levelUp: LevelUpEvent | null;
}

/** Streak multiplier for the current streak length (in days). */
export function streakMultiplier(days: number): number {
  if (days >= 30) return 1.5;
  if (days >= 14) return 1.4;
  if (days >= 7) return 1.25;
  if (days >= 3) return 1.1;
  return 1;
}

/** Raw XP for a commit of a given size (before multipliers/caps). */
export function commitXp(linesChanged: number): number {
  return COMMIT_BASE_XP + Math.min(COMMIT_SIZE_XP_CAP, Math.floor(Math.sqrt(linesChanged) * 4));
}

function pruneRolling(file: ProgressFile, now: number): void {
  file.rolling.promptTimes = file.rolling.promptTimes.filter((t) => now - t < HOUR_MS);
  file.rolling.commitTimes = file.rolling.commitTimes.filter((t) => now - t < HOUR_MS);
  const today = dayKey(new Date(now));
  if (file.rolling.dayKey !== today) {
    file.rolling.dayKey = today;
    file.rolling.dayXp = 0;
  }
}

/** Update streak for an XP event happening now. Returns the active multiplier. */
export function applyStreak(file: ProgressFile, now: number): number {
  const today = dayKey(new Date(now));
  const last = file.streak.lastActiveDay;
  if (last !== today) {
    const yesterday = dayKey(new Date(now - 24 * HOUR_MS));
    file.streak.current = last === yesterday ? file.streak.current + 1 : 1;
    file.streak.lastActiveDay = today;
    if (file.streak.current > file.streak.best) file.streak.best = file.streak.current;
  }
  return streakMultiplier(file.streak.current);
}

/**
 * Apply streak multiplier + daily soft cap to a base amount and credit it.
 * Splits the streak bonus out into its own xpBySource bucket.
 */
function creditXp(
  file: ProgressFile,
  base: number,
  source: "prompts" | "commits",
  now: number,
): number {
  const multiplier = applyStreak(file, now);
  const withStreak = base * multiplier;

  // Daily soft cap: XP beyond 500/day earns at 25%.
  const room = Math.max(0, DAILY_SOFT_CAP - file.rolling.dayXp);
  const full = Math.min(withStreak, room);
  const overflow = withStreak - full;
  const gained = Math.round(full + overflow * DAILY_OVERCAP_FACTOR);
  if (gained <= 0) return 0;

  // Attribute the capped gain proportionally between base and streak bonus.
  const capRatio = withStreak > 0 ? gained / withStreak : 0;
  const baseShare = Math.round(base * capRatio);
  const bonusShare = gained - baseShare;

  file.xp += gained;
  file.rolling.dayXp += gained;
  file.xpBySource[source] += baseShare;
  file.xpBySource.streakBonus += bonusShare;
  return gained;
}

function markProject(file: ProgressFile, cwd: string | undefined): void {
  if (!cwd) return;
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  if (!file.totals.projects.includes(hash)) file.totals.projects.push(hash);
}

function finishAward(file: ProgressFile, levelBefore: number, gained: number): AwardResult {
  const levelAfter = levelForXp(file.xp);
  let levelUp: LevelUpEvent | null = null;
  if (levelAfter > levelBefore) {
    levelUp = { from: levelBefore, to: levelAfter, rankName: rankForLevel(levelAfter).name };
  }
  file.lastEvent = { nonce: crypto.randomUUID(), levelUp };
  return { file, gained, levelUp };
}

/**
 * Award XP for one completed prompt (caller ensures the run finished, not canceled, ≥1 turn).
 * Diminishing returns: after 15 prompts in a rolling hour, +2 instead of +10.
 */
export function awardPrompt(file: ProgressFile, now: number, cwd?: string): AwardResult {
  const levelBefore = levelForXp(file.xp);
  pruneRolling(file, now);

  const base =
    file.rolling.promptTimes.length >= PROMPTS_PER_HOUR_FULL ? PROMPT_XP_DIMINISHED : PROMPT_XP;
  file.rolling.promptTimes.push(now);
  file.totals.prompts += 1;
  markProject(file, cwd);

  const gained = creditXp(file, base, "prompts", now);
  return finishAward(file, levelBefore, gained);
}

/**
 * Award XP for new commits. Dedupes by patch-id (reverts/recommits score 0) and caps
 * XP-earning commits at 6 per rolling hour (extra commits still count in totals).
 */
export function awardCommits(
  file: ProgressFile,
  commits: ScoredCommit[],
  now: number,
  cwd?: string,
): AwardResult {
  const levelBefore = levelForXp(file.xp);
  pruneRolling(file, now);

  let gained = 0;
  for (const commit of commits) {
    if (commit.patchId && file.patchIds.includes(commit.patchId)) continue;
    if (commit.patchId) file.patchIds.push(commit.patchId);

    file.totals.commits += 1;
    file.totals.linesShipped += commit.linesChanged;

    if (file.rolling.commitTimes.length >= COMMITS_PER_HOUR) continue;
    file.rolling.commitTimes.push(now);
    gained += creditXp(file, commitXp(commit.linesChanged), "commits", now);
  }
  if (commits.length > 0) markProject(file, cwd);

  return finishAward(file, levelBefore, gained);
}
