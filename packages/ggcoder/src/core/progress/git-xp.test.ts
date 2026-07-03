import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectNewCommits } from "./git-xp.js";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const gitAvailable = hasGit();
const d = gitAvailable ? describe : describe.skip;

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  }).trim();
}

async function commitFile(name: string, lines: number, message: string): Promise<string> {
  const content = Array.from({ length: lines }, (_, i) => `line ${i} of ${name}`).join("\n");
  await fs.writeFile(path.join(repo, name), content + "\n");
  git("add", name);
  git("commit", "-m", message);
  return git("rev-parse", "HEAD");
}

d("detectNewCommits", () => {
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "gg-gitxp-"));
    git("init", "-q");
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("first sight of a repo records HEAD without scoring", async () => {
    await commitFile("a.txt", 10, "initial");
    const result = await detectNewCommits(repo, undefined, Date.now());
    expect(result).not.toBeNull();
    expect(result!.commits).toHaveLength(0);
    expect(result!.head).toBe(git("rev-parse", "HEAD"));
  });

  it("scores new commits with line counts and patch ids", async () => {
    const base = await commitFile("a.txt", 5, "initial");
    const runStart = Date.now();
    await commitFile("b.txt", 30, "feature");
    const result = await detectNewCommits(repo, base, runStart);
    expect(result!.commits).toHaveLength(1);
    expect(result!.commits[0].linesChanged).toBe(30);
    expect(result!.commits[0].patchId).toMatch(/^[0-9a-f]{40}/);
  });

  it("returns no commits when HEAD is unchanged", async () => {
    const head = await commitFile("a.txt", 5, "initial");
    const result = await detectNewCommits(repo, head, Date.now());
    expect(result!.commits).toHaveLength(0);
  });

  it("excludes commits authored before the run window", async () => {
    const base = await commitFile("a.txt", 5, "initial");
    await commitFile("b.txt", 10, "old work");
    // Run "started" an hour from now — the commit above predates the window.
    const result = await detectNewCommits(repo, base, Date.now() + 60 * 60 * 1000);
    expect(result!.commits).toHaveLength(0);
  });

  it("resets the baseline silently when lastHead is unknown", async () => {
    await commitFile("a.txt", 5, "initial");
    const result = await detectNewCommits(repo, "0".repeat(40), Date.now());
    expect(result).not.toBeNull();
    expect(result!.commits).toHaveLength(0);
  });

  it("returns null for a non-repo directory", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "gg-plain-"));
    const result = await detectNewCommits(plain, undefined, Date.now());
    expect(result).toBeNull();
    await fs.rm(plain, { recursive: true, force: true });
  });
});
