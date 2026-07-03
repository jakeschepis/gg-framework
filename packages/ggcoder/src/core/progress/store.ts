// Durable progress persistence: locked atomic writes, HMAC signing, backup + recovery chain.
//
// The HMAC key ships in the app bundle, so this is a tamper *deterrent*, not tamper-proof —
// real integrity would need server-side recomputation (leaderboard phase).

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getAppPaths, withFileLock } from "@kenkaiiii/gg-core";
import type { ProgressFile } from "./types.js";

const HMAC_KEY = "gg-coder-progress-v1-9f2c4e7a1b8d3f6c";
const PATCH_ID_CAP = 500;

export interface ProgressStoreOptions {
  filePath?: string;
  backupPath?: string;
  /** Called when neither the main file nor the backup is usable. */
  rebuild?: () => Promise<ProgressFile | null>;
}

function resolvePaths(opts?: ProgressStoreOptions): { filePath: string; backupPath: string } {
  const paths = getAppPaths();
  return {
    filePath: opts?.filePath ?? paths.progressFile,
    backupPath: opts?.backupPath ?? paths.progressBackupFile,
  };
}

/** Stable-key JSON of the file minus `sig`, for signing. */
function canonicalJson(file: ProgressFile): string {
  const clone: Record<string, unknown> = { ...file };
  delete clone.sig;
  return stableStringify(clone);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

export function signProgress(file: ProgressFile): string {
  return crypto.createHmac("sha256", HMAC_KEY).update(canonicalJson(file)).digest("hex");
}

export function verifyProgress(file: ProgressFile): boolean {
  if (typeof file.sig !== "string" || file.sig.length === 0) return false;
  const expected = signProgress(file);
  try {
    return crypto.timingSafeEqual(Buffer.from(file.sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function dayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function createEmptyProgress(now = new Date()): ProgressFile {
  const file: ProgressFile = {
    v: 1,
    xp: 0,
    createdAt: now.toISOString(),
    totals: { prompts: 0, commits: 0, linesShipped: 0, projects: [] },
    xpBySource: { prompts: 0, commits: 0, streakBonus: 0 },
    streak: { current: 0, best: 0, lastActiveDay: "" },
    rolling: { promptTimes: [], commitTimes: [], dayXp: 0, dayKey: dayKey(now) },
    repos: {},
    patchIds: [],
    lastEvent: null,
    sig: "",
  };
  file.sig = signProgress(file);
  return file;
}

function isValidShape(file: unknown): file is ProgressFile {
  if (typeof file !== "object" || file === null) return false;
  const f = file as Partial<ProgressFile>;
  return (
    f.v === 1 &&
    typeof f.xp === "number" &&
    typeof f.createdAt === "string" &&
    typeof f.totals === "object" &&
    typeof f.streak === "object" &&
    typeof f.rolling === "object" &&
    typeof f.sig === "string"
  );
}

async function readFileIfValid(filePath: string): Promise<ProgressFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidShape(parsed)) return null;
    if (!verifyProgress(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, contents, "utf-8");
  await fs.rename(tmp, filePath);
}

/**
 * Read-only peek: main file → backup → null. Never writes — safe for fs.watch
 * reloads that may race an in-flight atomic rename.
 */
export async function peekProgress(opts?: ProgressStoreOptions): Promise<ProgressFile | null> {
  const { filePath, backupPath } = resolvePaths(opts);
  return (await readFileIfValid(filePath)) ?? (await readFileIfValid(backupPath));
}

/**
 * Load progress with the recovery chain: main file → backup → rebuild → empty.
 * Never silently zeroes a user if any recoverable state exists.
 */
export async function loadProgress(opts?: ProgressStoreOptions): Promise<ProgressFile> {
  const { filePath, backupPath } = resolvePaths(opts);
  const main = await readFileIfValid(filePath);
  if (main) return main;

  const backup = await readFileIfValid(backupPath);
  if (backup) {
    // Restore the main file from backup.
    await saveProgress(backup, opts).catch(() => {});
    return backup;
  }

  if (opts?.rebuild) {
    try {
      const rebuilt = await opts.rebuild();
      if (rebuilt) {
        rebuilt.sig = signProgress(rebuilt);
        await saveProgress(rebuilt, opts).catch(() => {});
        return rebuilt;
      }
    } catch {
      // fall through to empty
    }
  }

  const empty = createEmptyProgress();
  await saveProgress(empty, opts).catch(() => {});
  return empty;
}

/**
 * Save progress: sign, atomic write under a file lock, and maintain the backup
 * (written when the level increased — caller passes `levelledUp` — or at most once/day).
 */
export async function saveProgress(
  file: ProgressFile,
  opts?: ProgressStoreOptions,
  levelledUp = false,
): Promise<void> {
  const { filePath, backupPath } = resolvePaths(opts);
  // Keep the patch-id ring buffer bounded.
  if (file.patchIds.length > PATCH_ID_CAP) {
    file.patchIds = file.patchIds.slice(-PATCH_ID_CAP);
  }
  file.sig = signProgress(file);
  const contents = JSON.stringify(file, null, 2);

  await withFileLock(filePath, async () => {
    await atomicWrite(filePath, contents);
    if (levelledUp || (await backupIsStale(backupPath))) {
      await atomicWrite(backupPath, contents).catch(() => {});
    }
  });
}

async function backupIsStale(backupPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(backupPath);
    return Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000;
  } catch {
    return true; // missing → write it
  }
}

/**
 * Read-modify-write under the lock — the safe way for concurrent sidecars to award XP.
 */
export async function updateProgress(
  mutate: (file: ProgressFile) => Promise<{ file: ProgressFile; levelledUp: boolean }>,
  opts?: ProgressStoreOptions,
): Promise<ProgressFile> {
  const { filePath, backupPath } = resolvePaths(opts);
  return withFileLock(filePath, async () => {
    // Do the recovery read inside the SAME lock used by saveProgress, without
    // calling loadProgress/saveProgress recursively. That keeps multi-sidecar
    // read-modify-write atomic instead of racing a plain save on another lock.
    let current = (await readFileIfValid(filePath)) ?? (await readFileIfValid(backupPath));
    if (!current && opts?.rebuild) {
      current = await opts.rebuild().catch(() => null);
      if (current) current.sig = signProgress(current);
    }
    current ??= createEmptyProgress();

    const { file, levelledUp } = await mutate(current);
    if (file.patchIds.length > PATCH_ID_CAP) {
      file.patchIds = file.patchIds.slice(-PATCH_ID_CAP);
    }
    file.sig = signProgress(file);
    const contents = JSON.stringify(file, null, 2);
    await atomicWrite(filePath, contents);
    if (levelledUp || (await backupIsStale(backupPath))) {
      await atomicWrite(backupPath, contents).catch(() => {});
    }
    return file;
  });
}

export { dayKey };
