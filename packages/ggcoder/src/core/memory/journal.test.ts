import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectJournal,
  buildJournalPromptTail,
  ENTRY_MAX_CHARS,
  JOURNAL_RELATIVE_PATH,
  PROMPT_ENTRY_LIMIT,
} from "./journal.js";

const projects: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-journal-"));
  projects.push(dir);
  return dir;
}

const FIXED_DATE = () => new Date("2026-07-27T10:00:00Z");

afterEach(() => {
  for (const dir of projects.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ProjectJournal", () => {
  it("writes a reviewable markdown file inside the project", async () => {
    const cwd = project();
    const journal = new ProjectJournal(cwd, FIXED_DATE);

    await journal.append([{ tag: "request", text: "Was asked to: add retry logic" }]);

    const filePath = path.join(cwd, JOURNAL_RELATIVE_PATH);
    expect(fs.existsSync(filePath)).toBe(true);
    const body = fs.readFileSync(filePath, "utf-8");
    // Human-facing: a header explaining the file, and one diffable line per entry.
    expect(body).toContain("# Project memory");
    expect(body).toContain("- 2026-07-27 [request] Was asked to: add retry logic");
  });

  it("round-trips entries it wrote", async () => {
    const journal = new ProjectJournal(project(), FIXED_DATE);
    await journal.append([
      { tag: "request", text: "Was asked to: ship the parser" },
      { tag: "files", text: "Edited: src/parse.ts" },
    ]);

    expect(journal.read()).toEqual([
      { date: "2026-07-27", tag: "request", text: "Was asked to: ship the parser" },
      { date: "2026-07-27", tag: "files", text: "Edited: src/parse.ts" },
    ]);
  });

  it("reads back hand-edited entries and preserves human edits on append", async () => {
    const cwd = project();
    const journal = new ProjectJournal(cwd, FIXED_DATE);
    await journal.append([{ tag: "summary", text: "Original machine entry" }]);

    // A human corrects the file and adds a note of their own — the whole point
    // of using markdown in the repo instead of a binary log in ~/.gg.
    const filePath = path.join(cwd, JOURNAL_RELATIVE_PATH);
    const edited = fs
      .readFileSync(filePath, "utf-8")
      .replace("Original machine entry", "Corrected by a human")
      .concat("- 2026-07-26 [note] Hand-written by the reviewer\n");
    fs.writeFileSync(filePath, edited);

    await journal.append([{ tag: "files", text: "Edited: src/new.ts" }]);

    const texts = journal.read().map((entry) => entry.text);
    expect(texts).toEqual([
      "Corrected by a human",
      "Hand-written by the reviewer",
      "Edited: src/new.ts",
    ]);
    expect(fs.readFileSync(filePath, "utf-8")).not.toContain("Original machine entry");
  });

  it("skips entries whose text is already recorded", async () => {
    const journal = new ProjectJournal(project(), FIXED_DATE);
    await journal.append([{ tag: "files", text: "Edited: src/a.ts" }]);

    expect(await journal.append([{ tag: "files", text: "Edited: src/a.ts" }])).toBe(0);
    expect(journal.read()).toHaveLength(1);
  });

  it("clamps entry text and drops empty entries", async () => {
    const journal = new ProjectJournal(project(), FIXED_DATE);

    const written = await journal.append([
      { tag: "summary", text: "z".repeat(5000) },
      { tag: "summary", text: "   " },
    ]);

    expect(written).toBe(1);
    const [entry] = journal.read();
    expect(entry!.text.length).toBeLessThanOrEqual(ENTRY_MAX_CHARS);
    expect(entry!.text.endsWith("\u2026")).toBe(true);
  });

  it("collapses newlines so one entry can never become two lines", async () => {
    const journal = new ProjectJournal(project(), FIXED_DATE);
    await journal.append([{ tag: "summary", text: "line one\nline two\n- fake entry" }]);

    expect(journal.read()).toHaveLength(1);
    expect(journal.read()[0]!.text).toBe("line one line two - fake entry");
  });

  it("cuts a long entry at a sentence boundary, not mid-word", async () => {
    const journal = new ProjectJournal(project(), FIXED_DATE);
    // Comfortably over ENTRY_MAX_CHARS so truncation actually engages.
    const sentences =
      "Replaced the naive lowercase call in the slug helper with a regex substitution. " +
      "The first attempt dropped unicode characters entirely and broke two fixtures. " +
      "Fixed it by switching to an explicit character class. " +
      "Then rewrote the helper so it also trims leading hyphens from the output value. " +
      "Also updated the docblock to describe the new normalisation order in detail. " +
      "Finally confirmed the behaviour against the existing suite of unit tests today.";

    await journal.append([{ tag: "summary", text: sentences }]);

    const text = journal.read()[0]!.text;
    expect(text.length).toBeLessThanOrEqual(ENTRY_MAX_CHARS);
    // Ends on a complete sentence, with the truncation still visible.
    expect(text.endsWith(". \u2026")).toBe(true);
    expect(text).toContain("explicit character class.");
    // The severed sentence is absent rather than present as a fragment.
    expect(text).not.toContain("Finally confirmed");
  });

  it("falls back to a word boundary when no sentence end fits", async () => {
    const journal = new ProjectJournal(project(), FIXED_DATE);
    // One long clause: no terminal punctuation to cut back to.
    const words = Array.from({ length: 120 }, (_, i) => `token${i}`).join(" ");

    await journal.append([{ tag: "summary", text: words }]);

    const text = journal.read()[0]!.text;
    expect(text.length).toBeLessThanOrEqual(ENTRY_MAX_CHARS);
    // A whole token, never a severed one like "token4" cut from "token42".
    const lastToken = text
      .replace(/\u2026$/, "")
      .trim()
      .split(" ")
      .pop()!;
    expect(words.split(" ")).toContain(lastToken);
  });

  it("never severs a file path in the middle", async () => {
    const journal = new ProjectJournal(project(), FIXED_DATE);
    const paths = Array.from({ length: 40 }, (_, i) => `packages/ggcoder/src/module-${i}.ts`);

    await journal.append([{ tag: "files", text: `Edited: ${paths.join(", ")}` }]);

    const text = journal.read()[0]!.text;
    const listed = text
      .replace(/^Edited:\s*/, "")
      .replace(/\u2026$/, "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const entry of listed) expect(paths).toContain(entry);
  });

  it("leaves text that already fits completely untouched", async () => {
    const journal = new ProjectJournal(project(), FIXED_DATE);
    await journal.append([{ tag: "summary", text: "Short and complete." }]);

    expect(journal.read()[0]!.text).toBe("Short and complete.");
  });

  it("returns nothing for a project with no journal", () => {
    expect(new ProjectJournal(project()).read()).toEqual([]);
  });

  it("survives concurrent appends without losing entries", async () => {
    const cwd = project();
    // Separate instances, as two daemons sharing one project would be.
    const writers = Array.from({ length: 5 }, () => new ProjectJournal(cwd, FIXED_DATE));

    await Promise.all(
      writers.map((w, i) => w.append([{ tag: "files", text: `Edited: f${i}.ts` }])),
    );

    expect(new ProjectJournal(cwd).read()).toHaveLength(5);
  });
});

describe("buildJournalPromptTail", () => {
  it("costs nothing when the journal is empty", () => {
    expect(buildJournalPromptTail(new ProjectJournal(project()))).toBe("");
  });

  it("renders recent entries and points at the file for older ones", async () => {
    const cwd = project();
    const journal = new ProjectJournal(cwd, FIXED_DATE);
    for (let i = 0; i < PROMPT_ENTRY_LIMIT + 5; i++) {
      await journal.append([{ tag: "summary", text: `Entry number ${i}` }]);
    }

    const tail = buildJournalPromptTail(journal);
    expect(tail).toContain("## Project memory");
    // Newest entries are present, oldest are not.
    expect(tail).toContain(`Entry number ${PROMPT_ENTRY_LIMIT + 4}`);
    expect(tail).not.toContain("Entry number 0 ");
    // Older material is reachable, not silently dropped.
    expect(tail).toContain(JOURNAL_RELATIVE_PATH);
    expect(tail).toContain("5 older entries");
  });

  it("frames entries as past events, not current state", async () => {
    const journal = new ProjectJournal(project(), FIXED_DATE);
    await journal.append([{ tag: "files", text: "Edited: src/a.ts" }]);

    const tail = buildJournalPromptTail(journal);
    // Bench G: the model will not verify on its own, so the framing must at
    // least never present these as a description of how things are now.
    expect(tail).toContain("records of past events");
    expect(tail).toContain("check the code");
  });

  it("respects the char budget", async () => {
    const journal = new ProjectJournal(project(), FIXED_DATE);
    for (let i = 0; i < 8; i++) {
      await journal.append([{ tag: "summary", text: `${i} ${"long body ".repeat(30)}` }]);
    }

    const tail = buildJournalPromptTail(journal, { charBudget: 300 });
    expect(tail.length).toBeLessThan(700);
  });
});
