// The 50-rank ladder: 10 tiers × 5 levels, with CSS effect ids and tier glyphs.

import type { ProgressFile, ProgressSnapshot, RankLadderEntry } from "./types.js";

export const MAX_LEVEL = 50;

interface TierDef {
  name: string;
  glyph: string;
  effectId: string;
  ranks: [string, string, string, string, string];
}

const TIERS: TierDef[] = [
  {
    name: "Boot",
    glyph: "○",
    effectId: "dim",
    ranks: ["Lurker", "Tinkerer", "Prompter", "Looper", "Scripter"],
  },
  {
    name: "Ship",
    glyph: "◇",
    effectId: "plain",
    ranks: ["Patcher", "Forker", "Merger", "Shipper", "Builder"],
  },
  {
    name: "Flow",
    glyph: "◆",
    effectId: "blue",
    ranks: ["Hacker", "Stacker", "Debugger", "Compiler", "Operator"],
  },
  {
    name: "Craft",
    glyph: "⬖",
    effectId: "green",
    ranks: ["Toolsmith", "Machinist", "Optimizer", "Artificer", "Architect"],
  },
  {
    name: "Vibe",
    glyph: "✦",
    effectId: "gradient",
    ranks: ["Vibesmith", "Codeslinger", "Bytebender", "Overclocker", "Netrunner"],
  },
  {
    name: "Deep",
    glyph: "✧",
    effectId: "gradient-glow",
    ranks: ["Cipher", "Daemon", "Phantom", "Glitch", "Specter"],
  },
  {
    name: "Arcane",
    glyph: "❖",
    effectId: "animated",
    ranks: ["Warlock", "Technomancer", "Codeweaver", "Archmage", "Oracle"],
  },
  {
    name: "Root",
    glyph: "⬢",
    effectId: "gold",
    ranks: ["Shellmaster", "Kernelghost", "Gitlord", "Mainframe", "Root"],
  },
  {
    name: "Myth",
    glyph: "★",
    effectId: "gold-shimmer",
    ranks: ["Basilisk", "Ascendant", "Sentinel", "Harbinger", "Titan"],
  },
  {
    name: "Beyond",
    glyph: "✹",
    effectId: "iridescent",
    ranks: ["Anomaly", "Entity", "Overmind", "Deity", "Singularity"],
  },
];

/** Cumulative XP required to reach level n (level 1 = 0). */
export function xpForLevel(n: number): number {
  if (n <= 1) return 0;
  return Math.round(100 * Math.pow(n, 1.6));
}

/** Level for a cumulative XP total (1..MAX_LEVEL). */
export function levelForXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  return level;
}

export interface RankInfo {
  level: number;
  name: string;
  tier: number;
  tierName: string;
  tierGlyph: string;
  effectId: string;
}

/** Rank metadata for a level (clamped to 1..MAX_LEVEL). */
export function rankForLevel(level: number): RankInfo {
  const l = Math.min(Math.max(1, Math.floor(level)), MAX_LEVEL);
  const tierIndex = Math.floor((l - 1) / 5);
  const tier = TIERS[tierIndex];
  return {
    level: l,
    name: tier.ranks[(l - 1) % 5],
    tier: tierIndex + 1,
    tierName: tier.name,
    tierGlyph: tier.glyph,
    effectId: tier.effectId,
  };
}

/** Build the broadcast snapshot the webview renders verbatim. */
export function buildSnapshot(file: ProgressFile): ProgressSnapshot {
  const level = levelForXp(file.xp);
  const rank = rankForLevel(level);
  const floor = xpForLevel(level);
  const ceil = level >= MAX_LEVEL ? floor : xpForLevel(level + 1);
  const span = Math.max(1, ceil - floor);
  const into = Math.max(0, file.xp - floor);
  return {
    level,
    rankName: rank.name,
    tier: rank.tier,
    tierName: rank.tierName,
    tierGlyph: rank.tierGlyph,
    effectId: rank.effectId,
    xp: file.xp,
    xpIntoLevel: into,
    xpForLevel: span,
    percent: level >= MAX_LEVEL ? 100 : Math.min(100, Math.floor((into / span) * 100)),
    streak: { current: file.streak.current, best: file.streak.best },
    totals: {
      prompts: file.totals.prompts,
      commits: file.totals.commits,
      linesShipped: file.totals.linesShipped,
      projects: file.totals.projects.length,
    },
    xpBySource: { ...file.xpBySource },
    memberSince: file.createdAt,
    ladder: rankLadder(),
    levelUp: file.lastEvent?.levelUp ?? null,
    eventNonce: file.lastEvent?.nonce ?? null,
  };
}

/** Full 50-entry ladder for the scorecard. */
export function rankLadder(): RankLadderEntry[] {
  const ladder: RankLadderEntry[] = [];
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const rank = rankForLevel(level);
    ladder.push({
      level,
      name: rank.name,
      tier: rank.tier,
      tierName: rank.tierName,
      effectId: rank.effectId,
      xpRequired: xpForLevel(level),
    });
  }
  return ladder;
}
