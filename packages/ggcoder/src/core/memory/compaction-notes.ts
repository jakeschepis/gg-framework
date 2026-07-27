/**
 * Turn the detail compaction is about to throw away into durable journal
 * entries.
 *
 * Compaction is one-way: the summary replaces the messages and the specifics
 * are gone for good. That is the actual hole the journal exists to fill — an
 * entry written here survives the summary, the session and the next restart.
 *
 * **Every entry must be a past-tense record of something that already
 * happened.** Bench G showed that an injected note suppresses verification
 * entirely (5/5 checks → 0/5), so an entry that can later become false will be
 * asserted with full confidence and never re-checked. History cannot become
 * false, which is what makes this writer safe while a free-form "save a fact"
 * tool was not. Do not add a producer here that records current state.
 *
 * Deliberately conservative: at most a handful of bounded entries per
 * compaction. A journal that floods itself is one nobody can afford to read.
 */
import type { Message, ContentPart } from "@kenkaiiii/gg-ai";
// Single source of truth for entry truncation — both writers must cut at the
// same boundaries, or an entry's rendering would depend on which path made it.
import { clampEntryText } from "./journal.js";

/** Max notes written per compaction. A flooded log is an unreadable log. */
export const MAX_NOTES_PER_COMPACTION = 3;
/** Max file paths named in the files note. */
const MAX_FILES_LISTED = 8;
/** Max chars of the summary carried into a note. */
const SUMMARY_NOTE_CHARS = 360;

export interface CompactionNote {
  text: string;
  tag: string;
}

/**
 * Sections of the compactor's summary worth keeping in a durable journal.
 *
 * The compactor emits seven labelled sections. Most must NOT be journalled:
 *
 * - `Primary Request and Intent` / `User Messages` — already captured verbatim,
 *   and far more cheaply, by the `request` entry. Live measurement (bench H)
 *   showed 64% of the request entry's words repeated inside the summary.
 * - `Files Touched` — already captured exactly by the `files` entry.
 * - `Current Work` / `Next Step` — in-flight state. True at the moment of
 *   compaction, false minutes later, and bench G proved a stale entry is
 *   asserted with full confidence and never re-checked. Journalling these
 *   would reintroduce exactly the failure this design exists to avoid.
 *
 * That leaves the two sections that are pure, permanent history — what was
 * actually done, and what went wrong and how it was fixed. Those are also the
 * only parts a future session cannot cheaply re-derive by reading the code.
 */
const DURABLE_SUMMARY_SECTIONS = ["What Was Done", "Errors and Fixes"];

const SECTION_HEADING = /^#{1,6}\s*(.+?)\s*$/;

/** Split a compactor summary into `heading -> body` pairs. */
function splitSections(summary: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (heading) sections.set(heading.toLowerCase(), body.join(" ").trim());
  };
  for (const line of summary.split("\n")) {
    const match = SECTION_HEADING.exec(line);
    if (match && line.trimStart().startsWith("#")) {
      flush();
      heading = match[1]!;
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

/** Strip markdown so an entry stays one clean, diffable line. */
function toProse(text: string): string {
  return text
    .replace(/<(read|modified)-files>[\s\S]*?<\/\1-files>/g, " ")
    .replace(/^\s*[-*]\s+/gm, " ")
    .replace(/^\s*\d+\.\s+/gm, " ")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The durable, non-duplicated part of a compaction summary. Falls back to the
 * whole summary when the expected headings are absent (the compactor's
 * extractive fallback path emits unstructured prose).
 */
function summaryToProse(summary: string): string {
  const stripped = summary.replace(/^\[Previous conversation summary\]/, "");
  const sections = splitSections(stripped);
  if (sections.size > 0) {
    const kept = DURABLE_SUMMARY_SECTIONS.map((name) => sections.get(name.toLowerCase()))
      .filter((body): body is string => Boolean(body && body.trim()))
      .map(toProse)
      .filter(Boolean);
    if (kept.length > 0) return kept.join(" ");
  }
  return toProse(stripped);
}

const MUTATING_TOOLS = new Set(["write", "edit"]);

/**
 * Safety net for the structural de-duplication above: drop any entry whose text
 * already appears verbatim inside another entry. Every journal entry is paid
 * for on every subsequent turn, so a duplicate is not a cosmetic problem.
 */
function dropContainedNotes(notes: CompactionNote[]): CompactionNote[] {
  return notes.filter((note, index) =>
    notes.every(
      (other, otherIndex) =>
        otherIndex === index ||
        !other.text.includes(note.text) ||
        // Identical texts: keep the first occurrence only.
        (other.text === note.text && otherIndex > index),
    ),
  );
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

/** Files the discarded span actually changed, in first-touch order. */
function changedFiles(dropped: readonly Message[]): string[] {
  const files: string[] = [];
  for (const message of dropped) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool_call" || !MUTATING_TOOLS.has(part.name)) continue;
      const target = (part.args as { file_path?: unknown } | undefined)?.file_path;
      if (typeof target !== "string" || files.includes(target)) continue;
      files.push(target);
      if (files.length >= MAX_FILES_LISTED) return files;
    }
  }
  return files;
}

/** The first real user request in the discarded span, if there was one. */
function firstUserRequest(dropped: readonly Message[]): string | undefined {
  for (const message of dropped) {
    if (message.role !== "user") continue;
    const text = textOf(message.content).trim();
    // Harness-injected framing (steering, loop-break, compaction summary) is
    // not something worth remembering across sessions.
    if (!text || text.startsWith("[")) continue;
    return text;
  }
  return undefined;
}

/**
 * Build the notes to persist for one compaction. `dropped` are the messages
 * being replaced; `summary` is the text replacing them.
 */
export function buildCompactionNotes(
  dropped: readonly Message[],
  summary: string,
): CompactionNote[] {
  const notes: CompactionNote[] = [];

  // Past tense throughout: these describe a session that is already over.
  const request = firstUserRequest(dropped);
  if (request) {
    notes.push({
      tag: "request",
      text: clampEntryText(`Was asked to: ${request}`, SUMMARY_NOTE_CHARS),
    });
  }

  const files = changedFiles(dropped);
  if (files.length > 0) {
    notes.push({
      tag: "files",
      text: clampEntryText(`Edited: ${files.join(", ")}`, SUMMARY_NOTE_CHARS),
    });
  }

  const summaryText = clampEntryText(summaryToProse(summary), SUMMARY_NOTE_CHARS);
  if (summaryText) {
    notes.push({ tag: "summary", text: summaryText });
  }

  return dropContainedNotes(notes).slice(0, MAX_NOTES_PER_COMPACTION);
}
