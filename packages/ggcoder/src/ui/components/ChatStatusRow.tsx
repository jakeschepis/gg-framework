import React from "react";
import { Box, Text } from "ink";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import { ActivityIndicator } from "./ActivityIndicator.js";
import type { ActivityPhase, RetryInfo } from "../hooks/useAgentLoop.js";
import type { Theme, useTheme } from "../theme/theme.js";
import { toolTonePalette, type ToolTone } from "../transcript/tool-presentation.js";
import { formatTokenCount } from "../terminal-history-format.js";
import { DOWN_ARROW } from "../constants/figures.js";

interface ChatStatusRowProps {
  visible: boolean;
  activityVisible: boolean;
  stallStatusVisible: boolean;
  doneStatus: {
    verb: string;
    durationMs: number;
    counts?: Record<string, number>;
    tokens?: number;
  } | null;
  columns: number;
  theme: ReturnType<typeof useTheme>;
  activityPhase: ActivityPhase;
  elapsedMs: number;
  runStartRef: React.RefObject<number>;
  thinkingMs: number;
  isThinking: boolean;
  thinkingLevel?: ThinkingLevel;
  tokenEstimate: number;
  charCountRef: React.RefObject<number>;
  realTokensAccumRef: React.RefObject<number>;
  userMessage?: string;
  activeToolNames: string[];
  retryInfo?: RetryInfo | null;
  planDone: number;
  planTotal: number;
  renderMarkdown: boolean;
  formatDuration: (durationMs: number) => string;
}

export function ChatStatusRow({
  visible,
  activityVisible,
  stallStatusVisible,
  doneStatus,
  columns,
  theme,
  activityPhase,
  elapsedMs,
  runStartRef,
  thinkingMs,
  isThinking,
  thinkingLevel,
  tokenEstimate,
  charCountRef,
  realTokensAccumRef,
  userMessage,
  activeToolNames,
  retryInfo,
  planDone,
  planTotal,
  renderMarkdown,
  formatDuration,
}: ChatStatusRowProps) {
  return (
    <Box paddingLeft={1} paddingRight={1} width={columns}>
      {visible ? (
        activityVisible ? (
          <ActivityIndicator
            phase={activityPhase}
            elapsedMs={elapsedMs}
            runStartRef={runStartRef}
            thinkingMs={thinkingMs}
            isThinking={isThinking}
            thinkingEnabled={!!thinkingLevel}
            tokenEstimate={tokenEstimate}
            charCountRef={charCountRef}
            realTokensAccumRef={realTokensAccumRef}
            userMessage={userMessage}
            activeToolNames={activeToolNames}
            retryInfo={retryInfo}
            planDone={planDone}
            planTotal={planTotal}
            staticDisplay
          />
        ) : stallStatusVisible ? (
          <Text color={theme.warning} wrap="truncate">
            {
              "⚠ API provider stream interrupted — retries exhausted. Your conversation is preserved."
            }
          </Text>
        ) : doneStatus ? (
          <Text>
            <Text color={theme.success}>
              {"✻ "}
              {doneStatus.verb} {formatDuration(doneStatus.durationMs)}
            </Text>
            <VitalSigns counts={doneStatus.counts} tokens={doneStatus.tokens} theme={theme} />
          </Text>
        ) : (
          <ReadyStatus theme={theme} renderMarkdown={renderMarkdown} />
        )
      ) : (
        <ReadyStatus theme={theme} renderMarkdown />
      )}
    </Box>
  );
}

/** Category → (tone for coloring, tool names that roll up into it). */
const VITAL_CATEGORIES: ReadonlyArray<{
  label: (n: number) => string;
  tone: ToolTone;
  tools: readonly string[];
}> = [
  { label: (n) => `${n} edit${n !== 1 ? "s" : ""}`, tone: "write", tools: ["edit", "write"] },
  { label: (n) => `${n} run${n !== 1 ? "s" : ""}`, tone: "run", tools: ["bash"] },
  {
    label: (n) => `${n} read${n !== 1 ? "s" : ""}`,
    tone: "read",
    tools: ["read", "grep", "find", "ls"],
  },
  {
    label: (n) => `${n} web`,
    tone: "web",
    tools: ["web_fetch", "web_search"],
  },
  { label: (n) => `${n} agent${n !== 1 ? "s" : ""}`, tone: "agent", tools: ["subagent"] },
];

/**
 * Per-run "vital signs" tail: tone-colored category chips + `↓ tokens`.
 * Omits the tail entirely when there are no counts (preserves the bare
 * `✻ {verb} {duration}` for chat-only turns).
 */
function VitalSigns({
  counts,
  tokens,
  theme,
}: {
  counts?: Record<string, number>;
  tokens?: number;
  theme: Theme;
}) {
  const chips: React.ReactNode[] = [];
  if (counts) {
    for (const cat of VITAL_CATEGORIES) {
      const total = cat.tools.reduce((sum, t) => sum + (counts[t] ?? 0), 0);
      if (total === 0) continue;
      chips.push(
        <Text key={cat.tone} color={toolTonePalette(theme, cat.tone).primary}>
          {" · "}
          {cat.label(total)}
        </Text>,
      );
    }
  }
  const showTokens = typeof tokens === "number" && tokens > 0;
  if (chips.length === 0 && !showTokens) return null;
  return (
    <Text>
      {chips}
      {showTokens && (
        <Text color={theme.accent}>
          {" · "}
          {DOWN_ARROW} {formatTokenCount(tokens)} tokens
        </Text>
      )}
    </Text>
  );
}

function ReadyStatus({
  theme,
  renderMarkdown,
}: {
  theme: ReturnType<typeof useTheme>;
  renderMarkdown: boolean;
}) {
  return (
    <Text>
      <Text color={theme.commandColor}>{"⠿ "}</Text>
      <Text color={theme.textDim}>{"Ready to go.."}</Text>
      {!renderMarkdown && <Text color={theme.warning}>{" · raw markdown mode"}</Text>}
    </Text>
  );
}
