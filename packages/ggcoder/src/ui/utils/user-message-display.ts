import stringWidth from "string-width";
import type { PasteInfo } from "../components/InputArea.js";
import type { PromptSegment } from "../../utils/prompt-enhancer.js";

export interface UserMessageDisplayPart {
  text: string;
  kind: "text" | "paste" | "term";
  /**
   * Render a single space before this part. Paste placeholders are separate
   * chunks that need breathing room; enhanced-term parts are cut out of the
   * middle of a sentence and must stay glued to their neighbours.
   */
  separated?: boolean;
}

/**
 * Split a submitted user message into the chunks both renderers draw — the live
 * Ink `<UserMessage>` and the `terminal-history` scrollback serializer. Keeping
 * the split here is what keeps those two in lockstep (see
 * `ui/tui-history-parity.test.tsx`).
 *
 * `segments` are prompt-enhancer segments (Ctrl+E). They are honoured only when
 * they still reconstruct `text` exactly, so an edited-after-enhance send can
 * never paint a highlight over the wrong words.
 */
export function getUserMessageDisplayParts(
  text: string,
  pasteInfo?: PasteInfo,
  segments?: readonly PromptSegment[],
): UserMessageDisplayPart[] {
  const hasPaste = pasteInfo != null && pasteInfo.length > 0;
  if (!hasPaste) {
    const highlighted = getHighlightedParts(text, honourSegments(text, pasteInfo, segments));
    if (highlighted) return highlighted;
    return [{ text: collapseSubmittedUserText(text) || "(empty)", kind: "text" }];
  }

  const typedBefore = collapseSubmittedUserText(text.slice(0, pasteInfo.offset));
  const typedAfter = collapseSubmittedUserText(text.slice(pasteInfo.offset + pasteInfo.length));
  const parts: UserMessageDisplayPart[] = [];
  if (typedBefore.length > 0) parts.push({ text: typedBefore, kind: "text" });
  parts.push({
    text: `[Pasted text #${pasteInfo.length} +${pasteInfo.lineCount} lines]`,
    kind: "paste",
    separated: parts.length > 0,
  });
  if (typedAfter.length > 0) parts.push({ text: typedAfter, kind: "text", separated: true });
  return parts;
}

/**
 * A pending Ctrl+E enhancement: the exact plain text pushed into the composer
 * plus the segments describing it.
 */
export interface PendingEnhancement {
  plain: string;
  segments: PromptSegment[];
}

/**
 * Submit-time gate: the enhancer's segments describe one exact string, so they
 * ride along only when the user sent that string untouched. Typing a single
 * character after Ctrl+E drops them — stale offsets would highlight (and
 * “teach”) the wrong words.
 */
export function enhancementsForSubmittedText(
  enhancement: PendingEnhancement | null | undefined,
  submitted: string,
): PromptSegment[] | undefined {
  if (enhancement == null) return undefined;
  return enhancement.plain === submitted ? enhancement.segments : undefined;
}

/**
 * The one gate every enhancement-aware renderer goes through. Returns the
 * segments only when they are safe to paint over `text`, i.e. they exist, carry
 * at least one corrected term, aren't competing with a paste placeholder, and
 * still reconstruct `text` character-for-character. That last check is what
 * makes an edited-after-enhance send silently fall back to plain rendering
 * instead of highlighting the wrong words.
 */
function honourSegments(
  text: string,
  pasteInfo: PasteInfo | undefined,
  segments: readonly PromptSegment[] | undefined,
): readonly PromptSegment[] | null {
  if (pasteInfo != null && pasteInfo.length > 0) return null;
  if (segments == null || segments.length === 0) return null;
  if (!segments.some((segment) => segment.kind === "term")) return null;
  if (segments.map((segment) => segment.text).join("") !== text) return null;
  return segments;
}

/**
 * Build term-aware parts from already-honoured prompt-enhancer segments.
 * Returns null when there are none — the caller then falls back to the plain
 * single-part rendering.
 */
function getHighlightedParts(
  text: string,
  segments: readonly PromptSegment[] | null,
): UserMessageDisplayPart[] | null {
  if (segments == null) return null;

  // Collapse exactly like the plain path, but carry each surviving character's
  // source offset so segment boundaries survive the newline squashing.
  const { out, sources } = collapseWithSources(text);
  if (out.length === 0) return null;

  const owners = ownerBySourceOffset(segments);
  const parts: UserMessageDisplayPart[] = [];
  let currentOwner = -1;
  for (let i = 0; i < out.length; i++) {
    const source = sources[i];
    // Injected separators (-1) stay with whichever segment preceded them, but
    // always render as prose — a " ⏎ " squashed newline is never part of the
    // corrected term and must not end up inside the highlight.
    const isSeparator = source < 0;
    const owner = isSeparator ? Math.max(currentOwner, 0) : owners[source];
    const kind: UserMessageDisplayPart["kind"] =
      !isSeparator && segments[owner].kind === "term" ? "term" : "text";
    const last = parts[parts.length - 1];
    // Adjacent prose segments merge; adjacent term segments never do, so two
    // corrected terms in a row stay visually distinct.
    const canExtend = last != null && owner === currentOwner && last.kind === kind;
    const canMerge = last != null && kind === "text" && last.kind === "text";
    if (canExtend || canMerge) {
      last.text += out[i];
    } else {
      parts.push({ text: out[i], kind });
    }
    currentOwner = owner;
  }
  return parts.filter((part) => part.text.length > 0);
}

/**
 * The teaching payload the terminal can't show as a hover tooltip (the way
 * gg-app's `EnhancedSegments` does): one dim footnote per corrected term,
 * naming what the user originally said. Returned pre-indented and
 * pre-truncated to `width` so the live Ink row and the scrollback serializer
 * draw byte-identical strings and can never wrap differently.
 *
 * Gated by the same `honourSegments` check as the highlighting, so notes and
 * highlights always appear together or not at all.
 */
export function getUserMessageTeachingNotes(
  text: string,
  pasteInfo: PasteInfo | undefined,
  segments: readonly PromptSegment[] | undefined,
  width: number,
): string[] {
  const honoured = honourSegments(text, pasteInfo, segments);
  if (honoured == null) return [];
  const available = Math.max(1, width);
  const notes: string[] = [];
  for (const segment of honoured) {
    if (segment.kind !== "term") continue;
    const original = flattenWhitespace(segment.original);
    if (original.length === 0) continue;
    const note = flattenWhitespace(segment.note ?? "");
    const body = `${NOTE_INDENT}${NOTE_GLYPH}${flattenWhitespace(segment.text)} — you said “${original}”${note ? ` · ${note}` : ""}`;
    notes.push(truncateToWidth(body, available));
  }
  return notes;
}

const NOTE_INDENT = "  ";
const NOTE_GLYPH = "↳ ";

function flattenWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Width-aware hard truncation (no wrapping) with an ellipsis. */
function truncateToWidth(text: string, max: number): string {
  if (stringWidth(text) <= max) return text;
  let out = "";
  for (const char of text) {
    if (stringWidth(`${out}${char}…`) > max) break;
    out += char;
  }
  return `${out}…`;
}

/** Map every character offset of the joined segment text to its segment index. */
function ownerBySourceOffset(segments: readonly PromptSegment[]): number[] {
  const owners: number[] = [];
  segments.forEach((segment, index) => {
    for (let i = 0; i < segment.text.length; i++) owners.push(index);
  });
  return owners;
}

const LINE_SEPARATOR = " ⏎ ";

/**
 * `collapseSubmittedUserText` with an index map: `sources[i]` is the offset in
 * `text` that produced `out[i]`, or -1 for an injected line separator.
 */
function collapseWithSources(text: string): { out: string; sources: number[] } {
  let out = "";
  const sources: number[] = [];
  const push = (chunk: string, startOffset: number): void => {
    for (let i = 0; i < chunk.length; i++) sources.push(startOffset < 0 ? -1 : startOffset + i);
    out += chunk;
  };

  let kept = 0;
  const lineBreak = /\r?\n/gu;
  let lineStart = 0;
  let match: RegExpExecArray | null;
  const lines: { text: string; start: number }[] = [];
  while ((match = lineBreak.exec(text)) !== null) {
    lines.push({ text: text.slice(lineStart, match.index), start: lineStart });
    lineStart = lineBreak.lastIndex;
  }
  lines.push({ text: text.slice(lineStart), start: lineStart });

  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed.length === 0) continue;
    if (kept > 0) push(LINE_SEPARATOR, -1);
    push(trimmed, line.start + (line.text.length - line.text.trimStart().length));
    kept++;
  }
  return { out, sources };
}

function collapseSubmittedUserText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(LINE_SEPARATOR);
}
