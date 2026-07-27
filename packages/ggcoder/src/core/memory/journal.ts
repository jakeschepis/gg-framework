/**
 * Project journal — durable, human-reviewable notes that survive compaction and
 * session restarts.
 *
 * The design is dictated by a measured result, not by taste. Bench G
 * (`bench/f-memory-staleness.mjs`) found that injected memory does not merely
 * inform a model, it REPLACES the act of checking: with no memory the model
 * verified against the repo 5/5 times; with any note present, 0/5 — and a false
 * note was then asserted as fact 5/5. Showing note ages and an explicit
 * "unverified, verify first" header fixed none of it. This is consistent with
 * published work: prompt-level freshness instructions are not a reliable fix.
 *
 * Three consequences, each of which is a rule here:
 *
 * 1. **Only past-tense history is stored.** An entry about something that
 *    already happened ("chose X over Y because Z") cannot become false, so
 *    suppressing re-verification of it costs nothing. Claims about current
 *    state ("the test runner is jest") decay silently and are then asserted
 *    with full confidence. Nothing in this module can write the latter: the
 *    only writer is the compactor, recording what a past session did.
 *
 * 2. **The file is markdown, in the project, and git-diffable.** Since the
 *    model provably will not catch a bad entry, the defence has to be outside
 *    the model: a human reads `.gg/memory.md` in a diff. A binary log in
 *    `~/.gg` would be invisible to exactly the reviewer who can catch it.
 *
 * 3. **No bespoke retrieval layer.** Recent entries ride in the prompt; the
 *    whole file is readable with the ordinary `read` tool. A custom
 *    store/tree/zoom stack would be machinery whose only job is to re-derive
 *    what `read` already does.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { withFileLock } from "@kenkaiiii/gg-core";

/** Project-relative location. In the repo, so it shows up in review. */
export const JOURNAL_RELATIVE_PATH = path.join(".gg", "memory.md");

/** Max characters of a single entry body. */
export const ENTRY_MAX_CHARS = 400;
/** Entries rendered into the prompt tail. Older ones stay in the file only. */
export const PROMPT_ENTRY_LIMIT = 8;
/** Hard cap on prompt-tail characters. */
export const PROMPT_CHAR_BUDGET = 1200;

const HEADER = [
  "# Project memory",
  "",
  "Past-tense notes written automatically when a session's history is compacted.",
  "Each entry records something that already happened, so it stays true.",
  "Edit or delete entries freely — this file is meant to be reviewed by humans.",
  "",
].join("\n");

export interface JournalEntry {
  /** ISO date (day precision) the entry was recorded. */
  date: string;
  /** Short grouping label, e.g. "request", "files", "summary". */
  tag: string;
  /** Bounded, past-tense body. */
  text: string;
}

/**
 * Fraction of the budget a boundary must retain to be worth cutting back to.
 * Below this we would be discarding more content than the tidier ending is
 * worth, so a plain word cut wins.
 */
const MIN_BOUNDARY_RATIO = 0.6;

/** End of a sentence: terminal punctuation, optional closer, then a space. */
const SENTENCE_END = /[.!?]["')\]]?\s/g;

/** Index just past the last sentence ending inside `window`, or -1. */
function lastSentenceEnd(window: string): number {
  let index = -1;
  SENTENCE_END.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END.exec(window)) !== null) {
    index = match.index + match[0].trimEnd().length;
  }
  return index;
}

/**
 * Collapse whitespace and fit `text` into `maxChars`, cutting at the cleanest
 * boundary available: sentence, then word, then a hard slice.
 *
 * A mid-word cut (`…read src/router.ts in fu…`) is what the live run produced,
 * and it is worse than it looks. The tail of an entry is usually its most
 * specific part — a file path, an identifier — so a fragment there invites a
 * later reader to guess at what was severed, which is exactly the kind of
 * confident guessing bench G showed the model will not go back and check.
 *
 * The result never exceeds `maxChars`, ellipsis included.
 */
export function clampEntryText(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;

  // Reserve room for the widest ellipsis form (" \u2026").
  const budget = Math.max(1, maxChars - 2);
  const window = collapsed.slice(0, budget);
  const floor = Math.floor(budget * MIN_BOUNDARY_RATIO);

  const sentence = lastSentenceEnd(window);
  // Terminal punctuation is kept, so separate the marker rather than doubling up.
  if (sentence >= floor) return `${collapsed.slice(0, sentence)} \u2026`;

  const word = window.lastIndexOf(" ");
  if (word >= floor) return `${collapsed.slice(0, word)}\u2026`;

  return `${window}\u2026`;
}

/** `- 2026-07-27 [tag] body` — one entry, one line, trivially diffable. */
function formatEntry(entry: JournalEntry): string {
  return `- ${entry.date} [${entry.tag}] ${entry.text}`;
}

const ENTRY_PATTERN = /^-\s+(\d{4}-\d{2}-\d{2})\s+\[([^\]]+)\]\s+(.*)$/;

function parseEntries(markdown: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of markdown.split("\n")) {
    const match = ENTRY_PATTERN.exec(line.trim());
    if (!match) continue;
    entries.push({ date: match[1]!, tag: match[2]!, text: match[3]!.trim() });
  }
  return entries;
}

export class ProjectJournal {
  readonly filePath: string;

  constructor(
    cwd: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.filePath = path.join(cwd, JOURNAL_RELATIVE_PATH);
  }

  /** Entries in file order, oldest first. Hand-edits are read back as written. */
  read(): JournalEntry[] {
    try {
      return parseEntries(fsSync.readFileSync(this.filePath, "utf-8"));
    } catch {
      return [];
    }
  }

  /**
   * Append entries under a file lock, re-reading inside it. Two daemons sharing
   * a project must not clobber each other, and an append is never a rewrite of
   * anything a human edited above it.
   */
  async append(entries: readonly Omit<JournalEntry, "date">[]): Promise<number> {
    const dated = entries
      .map((entry) => ({
        date: this.now().toISOString().slice(0, 10),
        tag: entry.tag,
        text: clampEntryText(entry.text, ENTRY_MAX_CHARS),
      }))
      .filter((entry) => entry.text.length > 0);
    if (dated.length === 0) return 0;

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    return withFileLock(this.filePath, async () => {
      let existing: string;
      try {
        existing = await fs.readFile(this.filePath, "utf-8");
      } catch {
        existing = HEADER;
      }
      // Skip entries whose exact text is already recorded: repeated compactions
      // of an unchanged span would otherwise stack identical lines.
      const known = new Set(parseEntries(existing).map((entry) => entry.text));
      const fresh = dated.filter((entry) => !known.has(entry.text));
      if (fresh.length === 0) return 0;

      // Blank line between the prose header and the entry list, so the file is
      // valid, readable markdown rather than a list glued to a paragraph.
      const trimmed = existing.trimEnd();
      const separator = /\n-\s/.test(trimmed) ? "\n" : "\n\n";
      const body = `${trimmed}${separator}${fresh.map(formatEntry).join("\n")}\n`;
      // Atomic replace: a crash mid-write leaves the previous file intact.
      const tempPath = `${this.filePath}.tmp`;
      await fs.writeFile(tempPath, body, "utf-8");
      await fs.rename(tempPath, this.filePath);
      return fresh.length;
    });
  }
}

/**
 * Recent journal entries for the uncached system-prompt tail, newest last.
 * Returns "" when the journal is empty, so an unused journal costs zero tokens.
 *
 * Older entries are deliberately NOT summarized into the prompt — they stay in
 * the file, and the pointer below tells the model how to read them. A summary
 * would be one more unverifiable assertion in context.
 */
export function buildJournalPromptTail(
  journal: ProjectJournal,
  options: { entryLimit?: number; charBudget?: number } = {},
): string {
  const entryLimit = options.entryLimit ?? PROMPT_ENTRY_LIMIT;
  const charBudget = options.charBudget ?? PROMPT_CHAR_BUDGET;
  const all = journal.read();
  if (all.length === 0) return "";

  const lines: string[] = [];
  let chars = 0;
  for (let i = all.length - 1; i >= 0 && lines.length < entryLimit; i--) {
    const line = formatEntry(all[i]!);
    if (chars + line.length > charBudget) break;
    chars += line.length;
    lines.push(line);
  }
  if (lines.length === 0) return "";
  lines.reverse();

  const older = all.length - lines.length;
  return [
    "## Project memory",
    `What earlier sessions did, oldest first. These are records of past events, not a ` +
      `description of the project's current state — check the code before relying on any of it.`,
    ...lines,
    older > 0
      ? `(${older} older ${older === 1 ? "entry" : "entries"} in ${JOURNAL_RELATIVE_PATH} — read that file if you need them.)`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
