import type { WorkerStatus } from "./types.js";

export interface BossUserItem {
  kind: "user";
  id: string;
  text: string;
  timestamp: number;
}

export interface BossAssistantItem {
  kind: "assistant";
  id: string;
  text: string;
  durationMs?: number;
  thinking?: string;
  thinkingMs?: number;
  continuation?: boolean;
}

export interface BossToolStartItem {
  kind: "tool_start";
  id: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
  animateUntil: number;
  progressOutput?: string;
}

export interface BossToolDoneItem {
  kind: "tool_done";
  id: string;
  toolCallId?: string;
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
  details?: unknown;
}

/**
 * A single tool within a coalesced group. Mirrors ggcoder's ToolGroupTool so
 * the shared `<ToolGroupExecution>` component and `buildToolGroupSummary` can
 * consume boss tool groups directly.
 */
export interface BossToolGroupTool {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done";
  animateUntil?: number;
  result?: string;
  isError?: boolean;
}

/**
 * Several consecutive same-name read-only tool calls collapsed into one row —
 * e.g. "Checked 4 workers: api, web, +2". Built in the boss store the same way
 * ggcoder's App coalesces read/grep/ls, then rendered with the shared ggcoder
 * `<ToolGroupExecution>` component (live) and `buildToolGroupSummary` (scrollback).
 */
export interface BossToolGroupItem {
  kind: "tool_group";
  id: string;
  tools: BossToolGroupTool[];
}

export interface BossWorkerEventItem {
  kind: "worker_event";
  id: string;
  project: string;
  status: WorkerStatus;
  finalText: string;
  toolsUsed: { name: string; ok: boolean }[];
  turnIndex: number;
  timestamp: string;
}

export interface BossWorkerErrorItem {
  kind: "worker_error";
  id: string;
  project: string;
  message: string;
  timestamp: string;
}

export interface BossInfoItem {
  kind: "info";
  id: string;
  text: string;
  level?: "info" | "warning" | "error";
}

export interface BossTaskDispatchItem {
  kind: "task_dispatch";
  id: string;
  tasks: { project: string; title: string }[];
  timestamp: number;
}

export interface BossUpdateNoticeItem {
  kind: "update_notice";
  id: string;
  text: string;
}

export interface BossCompactingItem {
  kind: "compacting";
  id: string;
}

export interface BossCompactedItem {
  kind: "compacted";
  id: string;
  originalCount: number;
  newCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

export interface BossStoppedItem {
  kind: "stopped";
  id: string;
  text: string;
}

export interface BossBannerItem {
  kind: "banner";
  id: string;
}

export type BossDisplayItem =
  | BossBannerItem
  | BossUserItem
  | BossAssistantItem
  | BossToolStartItem
  | BossToolDoneItem
  | BossToolGroupItem
  | BossWorkerEventItem
  | BossWorkerErrorItem
  | BossInfoItem
  | BossTaskDispatchItem
  | BossUpdateNoticeItem
  | BossCompactingItem
  | BossCompactedItem
  | BossStoppedItem;

export type BossTranscriptItem = BossDisplayItem;
