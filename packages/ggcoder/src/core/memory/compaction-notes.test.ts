import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { buildCompactionNotes, MAX_NOTES_PER_COMPACTION } from "./compaction-notes.js";
import { ENTRY_MAX_CHARS } from "./journal.js";

function edit(file: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id: file, name: "edit", args: { file_path: file } }],
  };
}

describe("buildCompactionNotes", () => {
  it("captures the request, the changed files and the summary", () => {
    const dropped: Message[] = [
      { role: "user", content: "add retry logic to the uploader" },
      edit("/repo/src/upload.ts"),
      edit("/repo/src/retry.ts"),
      { role: "assistant", content: "done" },
    ];

    const notes = buildCompactionNotes(
      dropped,
      "[Previous conversation summary]\n\nAdded retries.",
    );

    expect(notes.map((n) => n.tag)).toEqual(["request", "files", "summary"]);
    // Past tense throughout — an entry that reads as current state is the bug.
    expect(notes[0]!.text).toBe("Was asked to: add retry logic to the uploader");
    expect(notes[1]!.text).toContain("/repo/src/upload.ts");
    expect(notes[1]!.text).toContain("/repo/src/retry.ts");
    expect(notes[2]!.text).toBe("Added retries.");
  });

  it("ignores harness-injected user messages when picking the request", () => {
    const dropped: Message[] = [
      { role: "user", content: "[Previous conversation summary]\n\nolder stuff" },
      { role: "user", content: "[The user added this while you were working — ...]" },
      { role: "user", content: "the actual ask" },
    ];

    expect(buildCompactionNotes(dropped, "")[0]!.text).toContain("the actual ask");
  });

  it("never writes more notes than the cap, each within one record", () => {
    const dropped: Message[] = [
      { role: "user", content: "x".repeat(5000) },
      ...Array.from({ length: 40 }, (_, i) => edit(`/repo/file-${i}.ts`)),
    ];

    const notes = buildCompactionNotes(dropped, "y".repeat(5000));
    expect(notes.length).toBeLessThanOrEqual(MAX_NOTES_PER_COMPACTION);
    for (const note of notes) expect(note.text.length).toBeLessThanOrEqual(ENTRY_MAX_CHARS);
  });

  it("deduplicates repeatedly edited files", () => {
    const dropped: Message[] = [edit("/repo/a.ts"), edit("/repo/a.ts"), edit("/repo/b.ts")];

    const files = buildCompactionNotes(dropped, "")[0]!;
    expect(files.tag).toBe("files");
    expect(files.text).toBe("Edited: /repo/a.ts, /repo/b.ts");
  });

  /** The compactor's real section structure (see compaction/compactor.ts). */
  const FULL_SUMMARY =
    "[Previous conversation summary]\n\n" +
    "### Primary Request and Intent\n" +
    "Edit `src/slugify.ts` so the function replaces spaces with hyphens.\n\n" +
    "### User Messages\n" +
    '"Read src/slugify.ts, then edit it so the function also replaces spaces with hyphens."\n\n' +
    "### What Was Done\n" +
    "Replaced the naive lowercase call with a regex substitution.\n\n" +
    "### Files Touched\n" +
    "- `src/slugify.ts` — rewrote the transform\n\n" +
    "### Errors and Fixes\n" +
    "The first regex dropped unicode; fixed by using a character class.\n\n" +
    "### Current Work\n" +
    "About to add trimming of leading hyphens.\n\n" +
    "### Next Step\n" +
    "Run the test suite.";

  it("keeps only the durable summary sections and drops the duplicated ones", () => {
    const dropped: Message[] = [
      { role: "user", content: "edit slugify to replace spaces with hyphens" },
      edit("/repo/src/slugify.ts"),
    ];

    const summaryNote = buildCompactionNotes(dropped, FULL_SUMMARY).find(
      (n) => n.tag === "summary",
    )!;

    // Kept: pure history a future session cannot cheaply re-derive.
    expect(summaryNote.text).toContain("Replaced the naive lowercase call");
    expect(summaryNote.text).toContain("first regex dropped unicode");
    // Dropped: already covered by the `request` and `files` entries.
    expect(summaryNote.text).not.toContain("Primary Request and Intent");
    expect(summaryNote.text).not.toContain("Read src/slugify.ts, then edit");
    expect(summaryNote.text).not.toContain("rewrote the transform");
    // Dropped: in-flight state that would be stale on the next read.
    expect(summaryNote.text).not.toContain("About to add trimming");
    expect(summaryNote.text).not.toContain("Run the test suite");
  });

  it("renders each entry as one clean markdown-free line", () => {
    const note = buildCompactionNotes([{ role: "assistant", content: "ok" }], FULL_SUMMARY)[0]!;

    expect(note.text).not.toContain("#");
    expect(note.text).not.toContain("`");
    expect(note.text).not.toContain("\n");
  });

  it("falls back to the whole summary when it has no section headings", () => {
    // The compactor's extractive fallback path emits unstructured prose.
    const note = buildCompactionNotes(
      [{ role: "assistant", content: "ok" }],
      "[Previous conversation summary]\n\nModified two files and fixed a failing test.",
    )[0]!;

    expect(note.text).toBe("Modified two files and fixed a failing test.");
  });

  it("never emits an entry whose text is contained in another entry", () => {
    const dropped: Message[] = [{ role: "user", content: "do the thing" }];

    const notes = buildCompactionNotes(dropped, "### What Was Done\nWas asked to: do the thing");

    const texts = notes.map((n) => n.text);
    // Every journal entry is re-read on every later turn, so a contained
    // duplicate is recurring waste, not a cosmetic issue.
    for (const [i, text] of texts.entries()) {
      const others = texts.filter((_, j) => j !== i);
      expect(others.some((other) => other.includes(text))).toBe(false);
    }
  });

  it("writes nothing when there is nothing worth remembering", () => {
    expect(buildCompactionNotes([], "")).toEqual([]);
    expect(buildCompactionNotes([{ role: "assistant", content: "ok" }], "")).toEqual([]);
  });
});
