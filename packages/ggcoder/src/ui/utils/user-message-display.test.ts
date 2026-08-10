import { describe, expect, it } from "vitest";
import type { PromptSegment } from "../../utils/prompt-enhancer.js";
import {
  enhancementsForSubmittedText,
  getUserMessageDisplayParts,
  getUserMessageTeachingNotes,
} from "./user-message-display.js";

const SEGMENTS: PromptSegment[] = [
  { kind: "text", text: "Add " },
  { kind: "term", text: "debounce", original: "wait a bit", note: "delays until input settles" },
  { kind: "text", text: " to the search box and " },
  { kind: "term", text: "cache", original: "remember" },
  { kind: "text", text: " the results." },
];
const ENHANCED = SEGMENTS.map((segment) => segment.text).join("");

describe("getUserMessageDisplayParts with enhancer segments", () => {
  it("splits the message into prose and corrected-term parts", () => {
    const parts = getUserMessageDisplayParts(ENHANCED, undefined, SEGMENTS);

    expect(parts).toEqual([
      { text: "Add ", kind: "text" },
      { text: "debounce", kind: "term" },
      { text: " to the search box and ", kind: "text" },
      { text: "cache", kind: "term" },
      { text: " the results.", kind: "text" },
    ]);
  });

  it("never inserts a separator space around a term", () => {
    const parts = getUserMessageDisplayParts(ENHANCED, undefined, SEGMENTS);

    expect(parts.every((part) => part.separated !== true)).toBe(true);
    expect(parts.map((part) => part.text).join("")).toBe(ENHANCED);
  });

  it("keeps segment boundaries across collapsed newlines", () => {
    const segments: PromptSegment[] = [
      { kind: "text", text: "Add\n" },
      { kind: "term", text: "debounce", original: "wait a bit" },
      { kind: "text", text: "\nhere" },
    ];
    const parts = getUserMessageDisplayParts("Add\ndebounce\nhere", undefined, segments);

    expect(parts).toEqual([
      { text: "Add ⏎ ", kind: "text" },
      { text: "debounce", kind: "term" },
      { text: " ⏎ here", kind: "text" },
    ]);
  });

  it("drops the highlights when the draft was edited after enhancing", () => {
    const edited = "Add debouncing to the search box and cache the results.";
    const parts = getUserMessageDisplayParts(edited, undefined, SEGMENTS);

    expect(parts).toEqual([{ text: edited, kind: "text" }]);
  });

  it("ignores segments that carry no corrected term", () => {
    const parts = getUserMessageDisplayParts("just prose", undefined, [
      { kind: "text", text: "just prose" },
    ]);

    expect(parts).toEqual([{ text: "just prose", kind: "text" }]);
  });

  it("lets a paste placeholder win over enhancer segments", () => {
    const parts = getUserMessageDisplayParts(
      ENHANCED,
      { offset: 0, length: 4, lineCount: 3 },
      SEGMENTS,
    );

    expect(parts.some((part) => part.kind === "term")).toBe(false);
    expect(parts.some((part) => part.kind === "paste")).toBe(true);
  });
});

describe("getUserMessageTeachingNotes", () => {
  it("names the user's own phrasing for every corrected term", () => {
    expect(getUserMessageTeachingNotes(ENHANCED, undefined, SEGMENTS, 80)).toEqual([
      "  ↳ debounce — you said “wait a bit” · delays until input settles",
      "  ↳ cache — you said “remember”",
    ]);
  });

  it("truncates instead of wrapping so both renderers stay line-for-line equal", () => {
    const notes = getUserMessageTeachingNotes(ENHANCED, undefined, SEGMENTS, 24);

    expect(notes[0]).toBe("  ↳ debounce — you said…");
    expect(notes.every((note) => note.length <= 24)).toBe(true);
  });

  it("flattens newlines out of a model-supplied note", () => {
    const segments: PromptSegment[] = [
      { kind: "term", text: "idempotent", original: "safe to\nrun twice" },
    ];

    expect(getUserMessageTeachingNotes("idempotent", undefined, segments, 80)).toEqual([
      "  ↳ idempotent — you said “safe to run twice”",
    ]);
  });

  it("stays silent whenever the highlights are dropped", () => {
    expect(getUserMessageTeachingNotes("edited text", undefined, SEGMENTS, 80)).toEqual([]);
    expect(getUserMessageTeachingNotes(ENHANCED, undefined, undefined, 80)).toEqual([]);
    expect(
      getUserMessageTeachingNotes(ENHANCED, { offset: 0, length: 4, lineCount: 3 }, SEGMENTS, 80),
    ).toEqual([]);
  });
});

describe("enhancementsForSubmittedText", () => {
  it("attaches the segments to an unedited send", () => {
    expect(enhancementsForSubmittedText({ plain: ENHANCED, segments: SEGMENTS }, ENHANCED)).toEqual(
      SEGMENTS,
    );
  });

  it("drops them the moment a single character differs", () => {
    expect(
      enhancementsForSubmittedText({ plain: ENHANCED, segments: SEGMENTS }, `${ENHANCED} `),
    ).toBeUndefined();
    expect(enhancementsForSubmittedText(null, ENHANCED)).toBeUndefined();
  });
});
