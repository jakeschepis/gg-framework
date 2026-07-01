/**
 * Ken's context digest — assembled fresh on each `@Ken` question.
 *
 * The build session (GG Coder) and Ken are two separate `AgentSession` objects.
 * Ken never appears in GG Coder's transcript; on each question we read GG
 * Coder's `getMessages()`, distill it into a cheap text digest, and prepend it
 * to the user's question as Ken's prompt body. Ken's read-only tools fill any
 * gap the digest misses (he can read the actual files or screenshot the UI).
 *
 * Kept pure + dependency-light so it's unit-testable without booting the sidecar
 * (which runs `main()` at import time).
 */
import type { Message, ContentPart, ToolResult } from "@kenkaiiii/gg-ai";

/** How many of the most recent build-session messages to inline verbatim. */
export const KEN_RECENT_MESSAGE_LIMIT = 20;

/** Marker the compactor prepends to its summary user-message. */
const COMPACTION_SUMMARY_MARKER = "[Previous conversation summary]";

/** Max chars of any single message's rendered text in the digest. */
const MESSAGE_CHAR_CAP = 1500;

export interface KenDigestInput {
  /** The user's `@Ken …` text (already stripped of the mention). */
  question: string;
  /** `collectProjectContext(cwd)` output — CLAUDE.md/AGENTS.md up the tree. */
  projectContext: string[];
  cwd: string;
  gitBranch: string | null;
  /** Build session messages (`buildSession.getMessages()`). */
  messages: Message[];
  /** Platform string (defaults to process.platform). */
  platform?: string;
  /** Override the recent-message cap (tests). */
  recentLimit?: number;
}

/** Truncate long text and note how much was dropped. */
function cap(text: string, max = MESSAGE_CHAR_CAP): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} […${text.length - max} more chars]`;
}

/** Summarize one tool call to a `name(arg)` one-liner. */
function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const primary =
    args.file_path ??
    args.path ??
    args.pattern ??
    args.query ??
    args.command ??
    args.url ??
    undefined;
  const arg = typeof primary === "string" ? cap(primary, 80) : "";
  return arg ? `${name}(${arg})` : `${name}()`;
}

/** Render one message's role-tagged text, stripping image/blob payloads and
 *  summarizing tool calls/results to short lines. Returns null for empty/noise
 *  messages (e.g. a tool result that was only an image). */
function renderMessage(msg: Message): string | null {
  if (msg.role === "user") {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
            .join(" ")
            .trim();
    return text ? `**User:** ${cap(text)}` : null;
  }

  if (msg.role === "assistant") {
    if (typeof msg.content === "string") {
      return msg.content.trim() ? `**GG Coder:** ${cap(msg.content)}` : null;
    }
    const parts: string[] = [];
    const calls: string[] = [];
    for (const p of msg.content as ContentPart[]) {
      if (p.type === "text" && p.text.trim()) parts.push(p.text.trim());
      else if (p.type === "tool_call") calls.push(summarizeToolCall(p.name, p.args));
    }
    const segments: string[] = [];
    if (parts.length > 0) segments.push(cap(parts.join("\n")));
    if (calls.length > 0) segments.push(`[tools: ${calls.join(", ")}]`);
    return segments.length > 0 ? `**GG Coder:** ${segments.join(" ")}` : null;
  }

  if (msg.role === "tool") {
    const results = msg.content as ToolResult[];
    const texts: string[] = [];
    for (const tr of results) {
      if (typeof tr.content === "string") {
        if (tr.content.trim()) texts.push(tr.content.trim());
      } else {
        const t = tr.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .filter(Boolean)
          .join(" ")
          .trim();
        if (t) texts.push(t);
      }
    }
    if (texts.length === 0) return null;
    return `**Tool result:** ${cap(texts.join(" "), 400)}`;
  }

  return null;
}

/**
 * Build Ken's full context digest string. Pure — no I/O. The sidecar gathers the
 * inputs (project context, git, messages) and calls this.
 */
export function buildKenDigest(input: KenDigestInput): string {
  const recentLimit = input.recentLimit ?? KEN_RECENT_MESSAGE_LIMIT;
  const platform = input.platform ?? process.platform;

  // Find the latest compaction summary; everything newer is "recent activity".
  const isSummary = (m: Message): boolean =>
    m.role === "user" &&
    typeof m.content === "string" &&
    m.content.startsWith(COMPACTION_SUMMARY_MARKER);

  let summaryText = "";
  let summaryIndex = -1;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (isSummary(input.messages[i])) {
      summaryIndex = i;
      const c = input.messages[i].content;
      summaryText = typeof c === "string" ? c.slice(COMPACTION_SUMMARY_MARKER.length).trim() : "";
      break;
    }
  }

  // Recent conversation = messages after the summary (or the tail), skipping
  // the system message and the summary message itself.
  const afterSummary = input.messages.slice(summaryIndex + 1).filter((m) => m.role !== "system");
  const recent = afterSummary.slice(-recentLimit);
  const renderedRecent = recent.map(renderMessage).filter((l): l is string => l !== null);

  const sections: string[] = [];

  sections.push(
    `## Who you are\nYou are Ken Kai, mentoring the user inside GG Coder. Your persona is in your system prompt. Below is what GG Coder and the user are working on.`,
  );

  const building: string[] = [];
  if (input.projectContext.length > 0) building.push(input.projectContext.join("\n\n"));
  building.push(
    `- Working directory: ${input.cwd}`,
    `- Platform: ${platform}`,
    `- Git branch: ${input.gitBranch ?? "(not a git repo / unknown)"}`,
  );
  sections.push(`## What they're building\n${building.join("\n")}`);

  if (summaryText) {
    sections.push(`## Story so far\n${cap(summaryText, 4000)}`);
  }

  sections.push(
    `## Recent activity (GG Coder and user)\n${
      renderedRecent.length > 0 ? renderedRecent.join("\n\n") : "(no conversation yet)"
    }`,
  );

  sections.push(`## They just asked you\n${input.question.trim()}`);

  return sections.join("\n\n");
}
