import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmptyProgress,
  loadProgress,
  saveProgress,
  signProgress,
  updateProgress,
  verifyProgress,
  type ProgressStoreOptions,
} from "./store.js";
import type { ProgressFile } from "./types.js";

let dir: string;
let opts: ProgressStoreOptions;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-progress-"));
  opts = {
    filePath: path.join(dir, "progress.json"),
    backupPath: path.join(dir, "progress.backup.json"),
  };
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("HMAC signing", () => {
  it("round-trips sign + verify", () => {
    const file = createEmptyProgress();
    expect(verifyProgress(file)).toBe(true);
  });

  it("rejects tampered XP", () => {
    const file = createEmptyProgress();
    file.xp = 999_999;
    expect(verifyProgress(file)).toBe(false);
  });

  it("rejects a missing sig", () => {
    const file = createEmptyProgress();
    file.sig = "";
    expect(verifyProgress(file)).toBe(false);
  });
});

describe("save + load", () => {
  it("round-trips through disk", async () => {
    const file = createEmptyProgress();
    file.xp = 1234;
    await saveProgress(file, opts);
    const loaded = await loadProgress(opts);
    expect(loaded.xp).toBe(1234);
  });

  it("writes a backup on first save", async () => {
    await saveProgress(createEmptyProgress(), opts);
    const backup = JSON.parse(await fs.readFile(opts.backupPath!, "utf-8")) as ProgressFile;
    expect(verifyProgress(backup)).toBe(true);
  });

  it("restores from backup when main file is deleted", async () => {
    const file = createEmptyProgress();
    file.xp = 777;
    await saveProgress(file, opts);
    await fs.unlink(opts.filePath!);
    const loaded = await loadProgress(opts);
    expect(loaded.xp).toBe(777);
    // Main file restored too.
    const raw = JSON.parse(await fs.readFile(opts.filePath!, "utf-8")) as ProgressFile;
    expect(raw.xp).toBe(777);
  });

  it("restores from backup when main file is hand-edited (bad HMAC)", async () => {
    const file = createEmptyProgress();
    file.xp = 500;
    await saveProgress(file, opts);
    const tampered = JSON.parse(await fs.readFile(opts.filePath!, "utf-8")) as ProgressFile;
    tampered.xp = 999_999;
    await fs.writeFile(opts.filePath!, JSON.stringify(tampered));
    const loaded = await loadProgress(opts);
    expect(loaded.xp).toBe(500);
  });

  it("rebuilds when both main and backup are gone", async () => {
    const rebuilt = createEmptyProgress();
    rebuilt.xp = 4242;
    rebuilt.sig = signProgress(rebuilt);
    const loaded = await loadProgress({ ...opts, rebuild: async () => rebuilt });
    expect(loaded.xp).toBe(4242);
  });

  it("falls back to empty when nothing is recoverable", async () => {
    const loaded = await loadProgress(opts);
    expect(loaded.xp).toBe(0);
    expect(loaded.v).toBe(1);
  });

  it("survives corrupt JSON in the main file", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(opts.filePath!, "{not json!!");
    const loaded = await loadProgress(opts);
    expect(loaded.xp).toBe(0);
  });
});

describe("updateProgress", () => {
  it("applies a read-modify-write and re-signs", async () => {
    await saveProgress(createEmptyProgress(), opts);
    const updated = await updateProgress(async (f) => {
      f.xp += 100;
      return { file: f, levelledUp: false };
    }, opts);
    expect(updated.xp).toBe(100);
    expect(verifyProgress(updated)).toBe(true);
    const loaded = await loadProgress(opts);
    expect(loaded.xp).toBe(100);
  });

  it("caps the patch-id ring buffer at 500", async () => {
    const updated = await updateProgress(async (f) => {
      f.patchIds = Array.from({ length: 600 }, (_, i) => `pid-${i}`);
      return { file: f, levelledUp: false };
    }, opts);
    expect(updated.patchIds).toHaveLength(500);
    expect(updated.patchIds[0]).toBe("pid-100");
  });
});
