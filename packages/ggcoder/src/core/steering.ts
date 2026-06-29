import type { TextContent, ImageContent, VideoContent } from "@kenkaiiii/gg-ai";

type ContentPart = TextContent | ImageContent | VideoContent;
type UserContent = string | ContentPart[];

/**
 * Framing prepended to a mid-run steering message (a prompt the user submitted
 * while the agent was already working).
 *
 * Without this wrapper the queued text arrives as a bare top-level user turn,
 * identical to a brand-new request — so models treat it as the authoritative
 * instruction and silently abandon the original task. The wrapper names the
 * relationship (a second, concurrent instruction) and the one rule that kills
 * the failure mode: don't drop either side. The model already knows how to
 * merge two live instructions once it knows both are in force.
 */
export const STEERING_PREFIX =
  "[The user added this while you were working — fold it into the current " +
  "task, adjusting or extending as needed. Don't drop your original work or " +
  "this.]\n\n";

/** Wrap a plain-text steering message with the framing prefix. */
export function wrapSteeringText(text: string): string {
  return STEERING_PREFIX + text;
}

/**
 * Wrap a steering `UserContent` (string or multimodal parts) with the framing
 * prefix. Media blocks pass through untouched; the prefix is prepended to the
 * leading text so attachments still ride the same native-block path.
 */
export function wrapSteeringContent(content: UserContent): UserContent {
  if (typeof content === "string") return wrapSteeringText(content);
  return [{ type: "text", text: STEERING_PREFIX } as TextContent, ...content];
}
