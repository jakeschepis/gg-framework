import type { Message } from "@kenkaiiii/gg-ai";
import type {
  AutopilotMarkerPayload,
  AppMarkerPayload,
  KenTurnPayload,
} from "./session-manager.js";
import { STEERING_PREFIX } from "./steering.js";
import { AUTOPILOT_INJECTION_PREAMBLE } from "./autopilot-cycle.js";

export interface HistoryAutopilotMarker extends AutopilotMarkerPayload {
  /** Stable seed derived from persisted marker data for deterministic UI copy. */
  copySeed: string;
}

function markerKey(marker: AutopilotMarkerPayload): string {
  return JSON.stringify({
    phase: marker.phase,
    afterMessageCount: marker.afterMessageCount,
    reason: marker.reason ?? null,
    body: marker.body ?? null,
  });
}

export function autopilotMarkerCopySeed(marker: AutopilotMarkerPayload): string {
  return `${marker.phase}\0${marker.afterMessageCount}\0${marker.reason ?? ""}\0${marker.body ?? ""}`;
}

/**
 * Normalize persisted autopilot markers for transcript replay.
 *
 * Older compacted/continued sessions may carry markers whose original
 * `afterMessageCount` points beyond the restored message list. Replaying those
 * at EOF bunches old Ken all-clear bubbles at the bottom, so drop them. Also
 * dedupe exact marker payloads produced by old rewrite/re-persist paths.
 */
export function normalizeAutopilotMarkersForHistory(
  markers: readonly AutopilotMarkerPayload[],
  maxAfterMessageCount: number,
): HistoryAutopilotMarker[] {
  const seen = new Set<string>();
  const normalized: HistoryAutopilotMarker[] = [];

  for (const marker of markers) {
    if (marker.afterMessageCount > maxAfterMessageCount) continue;
    const key = markerKey(marker);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...marker, copySeed: autopilotMarkerCopySeed(marker) });
  }

  return normalized;
}

/**
 * Normalize persisted app transcript markers for replay: drop markers whose
 * anchor points beyond the restored message list (stale after compaction) and
 * dedupe exact payloads (old rewrite paths could re-append). Mirrors
 * {@link normalizeAutopilotMarkersForHistory}.
 */
export function normalizeAppMarkersForHistory(
  markers: readonly AppMarkerPayload[],
  maxAfterMessageCount: number,
): AppMarkerPayload[] {
  const seen = new Set<string>();
  const normalized: AppMarkerPayload[] = [];
  for (const marker of markers) {
    if (marker.afterMessageCount > maxAfterMessageCount) continue;
    const key = JSON.stringify({
      kind: marker.kind,
      afterMessageCount: marker.afterMessageCount,
      data: marker.data,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(marker);
  }
  return normalized;
}

/**
 * Normalize persisted Ken turns for replay. Unlike autopilot/app markers, Ken
 * turns carry real conversation — an out-of-range anchor (stale after
 * compaction) is CLAMPED to the last message instead of dropped, so the
 * exchange still renders (at the end, in order) rather than vanishing. Exact
 * duplicate payloads (old rewrite/re-persist paths) are deduped.
 */
export function normalizeKenTurnsForHistory(
  turns: readonly KenTurnPayload[],
  maxAfterMessageCount: number,
): KenTurnPayload[] {
  const seen = new Set<string>();
  const normalized: KenTurnPayload[] = [];
  for (const turn of turns) {
    const key = JSON.stringify({ q: turn.question, r: turn.reply, a: turn.afterMessageCount });
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(
      turn.afterMessageCount > maxAfterMessageCount
        ? { ...turn, afterMessageCount: maxAfterMessageCount }
        : turn,
    );
  }
  return normalized;
}

// ── User-row reconstruction ────────────────────────────────────────
// The persisted user message is what the MODEL saw — steering wrapper, saved-
// path notes, attached-files block. The live bubble showed only the typed
// text, so resume must strip the machine framing back out.

/** Separator AgentSession.buildAttachmentParts uses before the file-notes
 *  block appended to a user message's leading text part. */
const ATTACHED_FILES_HEADER = "Attached files (inspect with your tools):";

/** Attachment-note text parts injected alongside the typed text. These never
 *  appeared in the live user bubble. */
const ATTACHMENT_NOTE_PATTERNS = [
  /^\[Image saved at .+\]$/s,
  /^The user attached a video at .+/s,
  /^\[User attached a video file .+\]$/s,
];

export interface RestoredUserRow {
  /** The typed text as the live bubble showed it. */
  text: string;
  /** Attached image data URLs. */
  images: string[];
  /** True when the message carried a video the model could NOT watch natively
   *  (live showed an info row after the bubble). */
  videoWarning: boolean;
}

function stripSteering(text: string): string {
  return text.startsWith(STEERING_PREFIX) ? text.slice(STEERING_PREFIX.length) : text;
}

/** Strip the autopilot situational-awareness preamble that the sidecar prepends
 *  to every autopilot-injected build-session run (see frameAutopilotInjection).
 *  The live transcript shows the clean body via the autopilot "prompted" marker;
 *  on resume the raw session message must render the same clean instruction, not
 *  the machine-facing preamble. */
function stripAutopilotPreamble(text: string): string {
  return text.startsWith(AUTOPILOT_INJECTION_PREAMBLE)
    ? text.slice(AUTOPILOT_INJECTION_PREAMBLE.length).trimStart()
    : text;
}

function stripAttachedFilesBlock(text: string): string {
  if (text.startsWith(ATTACHED_FILES_HEADER)) return "";
  const idx = text.indexOf(`\n\n${ATTACHED_FILES_HEADER}`);
  return idx === -1 ? text : text.slice(0, idx);
}

/** Rebuild the live user bubble from a persisted user message's content. */
export function restoreUserRow(content: Message["content"]): RestoredUserRow {
  if (typeof content === "string") {
    return {
      text: stripAttachedFilesBlock(stripAutopilotPreamble(stripSteering(content))).trim(),
      images: [],
      videoWarning: false,
    };
  }
  const images: string[] = [];
  const textParts: string[] = [];
  let videoWarning = false;
  for (const c of content) {
    if (c.type === "image") {
      images.push(`data:${c.mediaType};base64,${c.data}`);
      continue;
    }
    if (c.type !== "text" || typeof c.text !== "string") continue;
    const stripped = stripAutopilotPreamble(stripSteering(c.text));
    if (stripped.startsWith("[User attached a video file")) videoWarning = true;
    if (ATTACHMENT_NOTE_PATTERNS.some((re) => re.test(stripped))) continue;
    const cleaned = stripAttachedFilesBlock(stripped);
    if (cleaned.trim()) textParts.push(cleaned);
  }
  return { text: textParts.join("\n\n").trim(), images, videoWarning };
}

/**
 * Split a persisted assistant message into per-bubble texts. Live streaming
 * ends the assistant bubble at every server_tool_call (see useAgentEvents'
 * server_tool_call case), so pre- and post-tool text render as separate rows.
 * Persisted content keeps that structure as separate text blocks — emit one
 * text per block instead of gluing them into a single row on resume.
 */
export function restoreAssistantTexts(content: Message["content"]): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  return content.flatMap((c) =>
    c.type === "text" && typeof c.text === "string" && c.text.trim() ? [c.text] : [],
  );
}
