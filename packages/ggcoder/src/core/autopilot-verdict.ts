/**
 * Autopilot Ken's verdict contract.
 *
 * In autopilot mode Ken never talks to the user — he auto-reviews GG Coder's
 * work and replies with exactly one of four machine-parseable verdicts. The
 * first non-empty line carries the keyword; anything after is the payload.
 *
 *   PROMPT
 *   <runnable GG Coder prompt body, 1-3 lines>
 *
 *   ALL_CLEAR
 *
 *   IGNORE
 *
 *   HUMAN
 *   <one short reason the human is needed>
 *
 * ALL_CLEAR and IGNORE both stop the cycle with nothing left to do, but they
 * mean different things to the UI: ALL_CLEAR is a verdict on real work ("GG
 * Coder built/changed something and it checks out") and renders a one-line Ken
 * marker. IGNORE means the turn was never worth reviewing in the first place
 * (small talk, a question, an ack, a mechanical operation with no code
 * changes) — it renders NOTHING, not even a marker, so trivial turns don't
 * spam the transcript with a Ken bubble that adds no information.
 *
 * Parsing is forgiving and safe-by-default: any reply we can't confidently map
 * to PROMPT, ALL_CLEAR, or IGNORE becomes a HUMAN stop, never a blind loop.
 */

export type AutopilotVerdict =
  | { kind: "prompt"; body: string }
  | { kind: "all_clear" }
  | { kind: "ignore" }
  | { kind: "human"; reason: string };

/** Cap on the raw-reply text we echo back as a HUMAN reason when Ken's output
 *  is unrecognized — keeps a garbage/huge reply from bloating the transcript. */
const RAW_REASON_CAP = 500;

const DEFAULT_HUMAN_REASON = "Ken flagged this for a human but gave no reason.";

/** Strip a leading/trailing ``` fence (optionally ```prompt) Ken may have wrapped
 *  the prompt body in out of chat habit. */
function stripPromptFence(body: string): string {
  const trimmed = body.trim();
  const fenceOpen = /^```[^\n]*\n?/;
  const fenceClose = /\n?```$/;
  if (fenceOpen.test(trimmed) && fenceClose.test(trimmed)) {
    return trimmed.replace(fenceOpen, "").replace(fenceClose, "").trim();
  }
  return trimmed;
}

/** Truncate long text and note how much was dropped. */
function cap(text: string, max = RAW_REASON_CAP): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} […${text.length - max} more chars]`;
}

/**
 * Parse Autopilot Ken's raw reply into a verdict. Never throws.
 */
export function parseAutopilotVerdict(reply: string): AutopilotVerdict {
  const raw = (reply ?? "").trim();
  if (!raw) {
    return { kind: "human", reason: DEFAULT_HUMAN_REASON };
  }

  const lines = raw.split("\n");
  // First non-empty line holds the keyword.
  let keywordLineIdx = 0;
  while (keywordLineIdx < lines.length && lines[keywordLineIdx].trim() === "") {
    keywordLineIdx++;
  }
  const keywordLine = (lines[keywordLineIdx] ?? "").trim();
  // Normalize the leading keyword: uppercase, drop a trailing colon, collapse a
  // space between words so "ALL CLEAR" and "ALL_CLEAR" both match.
  const normalized = keywordLine
    .toUpperCase()
    .replace(/[:.]+\s*$/, "")
    .trim();
  const collapsed = normalized.replace(/\s+/g, "_");

  const rest = lines
    .slice(keywordLineIdx + 1)
    .join("\n")
    .trim();

  if (collapsed === "ALL_CLEAR" || collapsed.startsWith("ALL_CLEAR")) {
    return { kind: "all_clear" };
  }

  // IGNORE / SKIP: the turn wasn't real work — nothing to say, nothing to show.
  if (
    collapsed === "IGNORE" ||
    collapsed.startsWith("IGNORE") ||
    collapsed === "SKIP" ||
    collapsed.startsWith("SKIP")
  ) {
    return { kind: "ignore" };
  }

  if (collapsed === "PROMPT" || collapsed.startsWith("PROMPT")) {
    // Prefer the body on the following lines; if the keyword line itself carried
    // inline text after "PROMPT:", fall back to that.
    let body = stripPromptFence(rest);
    if (!body) {
      const inline = keywordLine.replace(/^prompt[:\s]*/i, "").trim();
      body = stripPromptFence(inline);
    }
    if (!body) {
      return { kind: "human", reason: "Ken said to continue but gave no prompt." };
    }
    return { kind: "prompt", body };
  }

  if (collapsed === "HUMAN" || collapsed.startsWith("HUMAN")) {
    let reason = rest;
    if (!reason) {
      const inline = keywordLine.replace(/^human[:\s]*/i, "").trim();
      reason = inline;
    }
    return { kind: "human", reason: cap(reason) || DEFAULT_HUMAN_REASON };
  }

  // Unrecognized → stop and ask the human, echoing the raw reply for context.
  return { kind: "human", reason: cap(raw) };
}
