/**
 * Single source of truth for gg-boss transcript spacing. Both the live pane
 * (boss-transcript-rows.tsx) and the finalized scrollback printer
 * (boss-terminal-history.tsx) consume these so an item gets the SAME blank-line
 * treatment while streaming as it does once committed to history — no visual
 * jump as live rows flush into Static.
 *
 * `BOSS_SPACING_KINDS` are the item kinds that participate in spacing at all.
 * `BOSS_COMPACT_BOUNDARIES` are the `previous→current` transitions that should
 * stay tight (no blank line). Keep this aligned with gg-coder's default
 * transcript spacing so boss replies, tool rows, and worker summaries breathe
 * the same way live and after they flush into scrollback.
 */
export const BOSS_SPACING_KINDS: ReadonlySet<string> = new Set<string>([
  "user",
  "assistant",
  "tool_start",
  "tool_done",
  "tool_group",
  "worker_event",
  "worker_error",
  "task_dispatch",
  "info",
  "update_notice",
  "compacting",
  "compacted",
  "stopped",
]);

export const BOSS_COMPACT_BOUNDARIES: ReadonlySet<string> = new Set<string>([
  "user→assistant",
  "assistant→user",
  "user→queued",
]);
