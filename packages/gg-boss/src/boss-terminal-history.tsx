import {
  serializeCompletedItemToTerminalHistory,
  type TerminalHistoryContext,
} from "@kenkaiiii/ggcoder/ui/terminal-history";
import {
  formatHistoryWrite,
  color,
  dim,
  gradientLine,
  indent,
  RESPONSE_LEFT_PADDING,
  stripAnsi,
  truncatePlain,
  wrapPlain,
} from "@kenkaiiii/ggcoder/ui/terminal-history-format";
import { shouldSeparateTranscriptItemKinds } from "@kenkaiiii/ggcoder/ui/transcript/spacing";
import { buildToolGroupSummary } from "@kenkaiiii/ggcoder/ui/tool-group-summary";
import { toolTonePalette } from "@kenkaiiii/ggcoder/ui/transcript/tool-presentation";
import type { BossDisplayItem } from "./boss-ui-items.js";
import { bossToolGroupRenderers } from "./boss-tool-group-summary.js";
import { BOSS_SPACING_KINDS, BOSS_COMPACT_BOUNDARIES } from "./boss-spacing.js";
import { AUTHOR, BRAND, COLORS, GRADIENT, LOGO_GAP, LOGO_LINES, VERSION } from "./branding.js";
import { parseStatusGrade } from "./boss-transcript-rows.js";
import { projectColor } from "./colors.js";

type GGCoderCompletedItem = Parameters<typeof serializeCompletedItemToTerminalHistory>[0];
type BossToolInlineSummary = string | { text: string; color: string };
type BossGGCoderHistoryItem = Extract<
  BossDisplayItem,
  {
    kind:
      | "user"
      | "assistant"
      | "tool_start"
      | "tool_done"
      | "info"
      | "compacting"
      | "compacted"
      | "stopped";
  }
>;

export interface BossTerminalHistoryPrinter {
  print(
    items: readonly BossDisplayItem[],
    context: TerminalHistoryContext,
    options?: { force?: boolean; write?: (data: string) => void },
  ): void;
  clear(): void;
  resetPrinted(): void;
  readonly printedIds: ReadonlySet<string>;
}

export interface BossTerminalHistoryPrinterOptions {
  stream?: NodeJS.WriteStream;
}

export function createBossTerminalHistoryPrinter({
  stream = process.stdout,
}: BossTerminalHistoryPrinterOptions = {}): BossTerminalHistoryPrinter {
  const printed = new Set<string>();
  let previousPrintedKind: string | null = null;

  return {
    print(items, context, options) {
      const writeOutput = options?.write ?? ((data: string) => void stream.write(data));
      for (const item of items) {
        if (!options?.force && printed.has(item.id)) continue;
        const output = serializeBossItemToTerminalHistory(item, context);
        const formatted = formatHistoryWrite(output, {
          leadingSeparator:
            item.kind === "banner"
              ? false
              : shouldSeparateTranscriptItemKinds({
                  previousKind: previousPrintedKind ?? undefined,
                  currentKind: item.kind,
                  spacingKinds: BOSS_SPACING_KINDS,
                  compactBoundaries: BOSS_COMPACT_BOUNDARIES,
                }),
          trailingBlankLine: item.kind === "banner",
          trailingNewlines: item.kind === "user" ? 1 : undefined,
        });
        if (formatted.length === 0) continue;
        printed.add(item.id);
        writeOutput(formatted);
        previousPrintedKind = item.kind;
      }
    },
    clear() {
      printed.clear();
      previousPrintedKind = null;
    },
    resetPrinted() {
      printed.clear();
      previousPrintedKind = null;
    },
    get printedIds() {
      return printed;
    },
  };
}

export function serializeBossItemToTerminalHistory(
  item: BossDisplayItem,
  context: TerminalHistoryContext,
): string {
  switch (item.kind) {
    case "banner":
      return renderBanner(context);
    case "worker_event":
      return renderWorkerEvent(item, context);
    case "worker_error":
      return renderWorkerError(item, context);
    case "task_dispatch":
      return renderTaskDispatch(item, context);
    case "tool_group":
      return renderToolGroup(item, context);
    case "update_notice":
      return renderUpdateNotice(item, context);
    default:
      return serializeCompletedItemToTerminalHistory(toGGCoderCompletedItem(item), context);
  }
}

function renderBanner(context: TerminalHistoryContext): string {
  const logo = LOGO_LINES.map((lineText) => gradientLine(lineText, GRADIENT));
  const shortcuts = `${color(COLORS.primary, "^T")} ${dim(context, "tasks  ")}${color(
    COLORS.primary,
    "Tab",
  )} ${dim(context, "scope  ")}${color(COLORS.primary, "⇧Tab")} ${dim(
    context,
    "thinking  ",
  )}${color(COLORS.primary, "ESC")} ${dim(context, "interrupt")}`;

  return [
    "",
    `${logo[0]}${LOGO_GAP}${color(COLORS.primary, BRAND, true)}${dim(
      context,
      ` v${VERSION} · By `,
    )}${color(COLORS.text, AUTHOR, true)}`,
    `${logo[1]}${LOGO_GAP}${color(COLORS.accent, "Orchestrator")}`,
    `${logo[2]}${LOGO_GAP}${shortcuts}`,
    "",
  ].join("\n");
}

function renderUpdateNotice(
  item: Extract<BossDisplayItem, { kind: "update_notice" }>,
  context: TerminalHistoryContext,
): string {
  return renderRoundNoticeBox(
    [`${color(COLORS.accent, "✨ ", true)}${color(COLORS.primary, item.text, true)}`],
    context,
    COLORS.accent,
  );
}

function renderToolGroup(
  item: Extract<BossDisplayItem, { kind: "tool_group" }>,
  context: TerminalHistoryContext,
): string {
  const tools = item.tools;
  const allDone = tools.every((tool) => tool.status === "done");
  const hasError = tools.some((tool) => tool.isError);
  const status = allDone ? (hasError ? "error" : "done") : "running";
  const label = buildToolGroupSummary(tools, allDone, bossToolGroupRenderers)
    .map((seg) => {
      const hex = seg.tone
        ? toolTonePalette(context.theme, seg.tone).primary
        : context.theme.toolName;
      return color(hex, seg.text, seg.bold);
    })
    .join("");
  return toolStatusHeader({ status, label, context, labelAlreadyStyled: true });
}

function renderWorkerEvent(
  item: Extract<BossDisplayItem, { kind: "worker_event" }>,
  context: TerminalHistoryContext,
): string {
  const theme = context.theme;
  const failedCount = item.toolsUsed.filter((tool) => !tool.ok).length;
  const grade = parseStatusGrade(item.finalText);
  const isError = grade === "BLOCKED" || failedCount > 0;
  const isWarning = grade === "UNVERIFIED" || grade === "PARTIAL";
  const statusColor = isError ? theme.error : isWarning ? theme.warning : theme.success;
  const headerColor = isError ? theme.error : projectColor(item.project);
  return toolStatusHeader({
    status: isError ? "error" : isWarning ? "queued" : "done",
    label: color(headerColor, item.project, true),
    suffix: `${color(theme.text, `  turn ${item.turnIndex}`)}${grade ? `${dim(context, "  ·  ")}${color(statusColor, grade, true)}` : ""}`,
    context,
    labelAlreadyStyled: true,
  });
}

function renderWorkerError(
  item: Extract<BossDisplayItem, { kind: "worker_error" }>,
  context: TerminalHistoryContext,
): string {
  return [
    toolStatusHeader({
      status: "error",
      label: color(context.theme.error, item.project, true),
      suffix: dim(context, "  worker error"),
      context,
      labelAlreadyStyled: true,
    }),
    messageResponseText(color(context.theme.error, item.message), context),
  ].join("\n");
}

function renderTaskDispatch(
  item: Extract<BossDisplayItem, { kind: "task_dispatch" }>,
  context: TerminalHistoryContext,
): string {
  const count = item.tasks.length;
  const lines = [
    toolStatusHeader({
      status: "done",
      label: color(context.theme.text, `Running ${count} task${count === 1 ? "" : "s"}:`, true),
      context,
      dotColor: COLORS.primary,
      labelAlreadyStyled: true,
    }),
  ];
  for (const task of item.tasks) {
    lines.push(
      `   • ${color(projectColor(task.project), task.project, true)}${dim(context, ": ")}${color(context.theme.text, task.title)}`,
    );
  }
  return lines.join("\n");
}

function toGGCoderCompletedItem(item: BossGGCoderHistoryItem): GGCoderCompletedItem {
  switch (item.kind) {
    case "user":
      return { kind: "user", id: item.id, text: item.text };
    case "assistant":
      return {
        kind: "assistant",
        id: item.id,
        text: item.text,
        thinking: item.thinking,
        thinkingMs: item.thinkingMs,
        continuation: item.continuation,
      };
    case "tool_start":
      return {
        kind: "tool_start",
        id: item.id,
        toolCallId: item.toolCallId,
        name: item.name,
        args: formatBossToolArgsForHistory(item.name, item.args),
        startedAt: item.startedAt,
        animateUntil: item.animateUntil,
        progressOutput: item.progressOutput,
      };
    case "tool_done":
      return {
        kind: "tool_done",
        id: item.id,
        name: item.name,
        args: formatBossToolArgsForHistory(item.name, item.args),
        result: formatBossToolResultForHistory(item.name, item.result, item.isError),
        isError: item.isError,
        durationMs: item.durationMs,
        details: item.details,
      };
    case "info":
      return { kind: "info", id: item.id, text: item.text };
    case "compacting":
      return { kind: "compacting", id: item.id };
    case "compacted":
      return {
        kind: "compacted",
        id: item.id,
        originalCount: item.originalCount,
        newCount: item.newCount,
        tokensBefore: item.tokensBefore,
        tokensAfter: item.tokensAfter,
      };
    case "stopped":
      return { kind: "stopped", id: item.id, text: item.text };
  }
}

function formatBossToolArgsForHistory(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (name) {
    case "list_workers":
      return { action: "workers" };
    case "get_worker_status":
    case "get_worker_summary":
      return { action: String(args.project ?? "") };
    case "prompt_worker": {
      const project = String(args.project ?? "");
      const message = String(args.message ?? "").replace(/\s+/gu, " ");
      const fresh = args.fresh === true ? "fresh · " : "";
      const detail = project ? `${fresh}${project} · ${message}` : `${fresh}${message}`;
      return {
        action: truncatePlain(detail, Math.max(20, contextlessPromptWorkerDetailLen(project))),
      };
    }
    default:
      return args;
  }
}

function formatBossToolResultForHistory(name: string, result: string, isError: boolean): string {
  if (isError) return result;
  const inline = formatBossToolInlineForHistory(name, result);
  if (!inline) return result;
  return typeof inline === "string" ? inline : inline.text;
}

function formatBossToolInlineForHistory(
  name: string,
  result: string,
): BossToolInlineSummary | undefined {
  switch (name) {
    case "list_workers": {
      const lines = result.split("\n").filter((lineText) => lineText.startsWith("-"));
      return `${lines.length} worker${lines.length === 1 ? "" : "s"}`;
    }
    case "prompt_worker": {
      if (result.includes("currently working")) return "busy — skipped";
      if (result.includes("Unknown project")) return "unknown project";
      return "dispatched";
    }
    case "get_worker_status": {
      const parts = result.split(":");
      if (parts.length < 2) return undefined;
      return parts.slice(1).join(":").trim();
    }
    case "get_worker_summary": {
      const turnMatch = result.match(/Turn:\s*(\d+)/u);
      const toolsMatch = result.match(/Tools used:\s*(.+)/u);
      const tools = toolsMatch ? toolsMatch[1] : "";
      const toolCount = tools && tools !== "(no tools used)" ? tools.split(",").length : 0;
      const turn = turnMatch ? `turn ${turnMatch[1]}` : undefined;
      const toolSummary =
        toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : undefined;
      return [turn, toolSummary].filter(Boolean).join(" · ") || undefined;
    }
    default:
      return undefined;
  }
}

function contextlessPromptWorkerDetailLen(project: string): number {
  const cols = process.stdout.columns ?? 80;
  const fixed = 2 + 13 + 1 + project.length + 3 + 1 + 1 + 11 + 6;
  return Math.max(20, cols - fixed);
}

function toolStatusHeader({
  status,
  label,
  suffix = "",
  context,
  dotColor,
  labelAlreadyStyled = false,
}: {
  status: "running" | "done" | "error" | "queued";
  label: string;
  suffix?: string;
  context: TerminalHistoryContext;
  dotColor?: string;
  labelAlreadyStyled?: boolean;
}): string {
  const resolvedDotColor =
    dotColor ??
    (status === "error"
      ? context.theme.error
      : status === "done"
        ? context.theme.success
        : status === "queued"
          ? context.theme.warning
          : context.theme.spinnerColor);
  const indicator = status === "running" ? "⠋" : "⏺";
  const labelText = labelAlreadyStyled ? label : color(context.theme.toolName, label, true);
  return `${RESPONSE_LEFT_PADDING}${color(resolvedDotColor, indicator)} ${labelText}${suffix}`;
}

function messageResponseText(text: string, context: TerminalHistoryContext): string {
  const [first, ...rest] = wrapPlain(text, Math.max(10, context.columns - 8)).split("\n");
  return [
    `${RESPONSE_LEFT_PADDING}${dim(context, "  ⎿  ")}${first ?? ""}`,
    ...rest.map((lineText) => `${RESPONSE_LEFT_PADDING}${dim(context, "     ")}${lineText}`),
  ].join("\n");
}

function renderRoundNoticeBox(
  lines: readonly string[],
  context: TerminalHistoryContext,
  borderColor: string,
): string {
  const width = Math.max(
    4,
    Math.min(
      context.columns - RESPONSE_LEFT_PADDING.length,
      Math.max(...lines.map((lineText) => stripAnsi(lineText).length)) + 4,
    ),
  );
  const contentWidth = Math.max(1, width - 4);
  const top = `${color(borderColor, "╭")}${color(borderColor, "─".repeat(width - 2))}${color(
    borderColor,
    "╮",
  )}`;
  const bottom = `${color(borderColor, "╰")}${color(borderColor, "─".repeat(width - 2))}${color(
    borderColor,
    "╯",
  )}`;
  const body = lines
    .flatMap((lineText) => wrapPlain(lineText, contentWidth).split("\n"))
    .map((lineText) => {
      const plainLength = stripAnsi(lineText).length;
      return `${color(borderColor, "│")} ${lineText}${" ".repeat(Math.max(0, contentWidth - plainLength))} ${color(borderColor, "│")}`;
    });
  return indent([top, ...body, bottom].join("\n"), RESPONSE_LEFT_PADDING);
}
