import {
  detailSuffix,
  plural,
  type GroupRenderer,
  type SummarySegment,
  type ToolGroupSummaryTool,
} from "@kenkaiiii/ggcoder/ui/tool-group-summary";

/**
 * Boss orchestrator tools that are safe to coalesce into a single row when the
 * boss fires several in a burst (e.g. polling every worker's status). Mirrors
 * ggcoder's AGGREGATABLE_TOOLS but scoped to the boss's read-only inspection
 * tools — state-changing tools (prompt_worker, add_task, …) stay individual so
 * their per-call results remain visible.
 */
export const BOSS_AGGREGATABLE_TOOLS = new Set<string>([
  "prompt_worker",
  "get_worker_status",
  "get_worker_summary",
  "get_worker_activity",
  "list_workers",
  "list_tasks",
]);

function projectDetail(tools: readonly ToolGroupSummaryTool[]): string {
  return detailSuffix(tools.map((tool) => String(tool.args.project ?? "")));
}

function renderWorkerInspectionGroup(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
  labels: { running: string; done: string },
): SummarySegment[][] {
  const count = tools.length;
  return [
    [
      { text: allDone ? labels.done : labels.running, bold: true, tone: "state" },
      { text: " ", bold: false },
      { text: String(count), bold: true, tone: "state" },
      { text: ` ${plural(count, "worker")}${projectDetail(tools)}`, bold: false },
    ],
  ];
}

const renderWorkerStatusGroup: GroupRenderer = (tools, allDone) =>
  renderWorkerInspectionGroup(tools, allDone, { running: "Checking", done: "Checked" });

const renderWorkerSummaryGroup: GroupRenderer = (tools, allDone) =>
  renderWorkerInspectionGroup(tools, allDone, { running: "Summarizing", done: "Summarized" });

const renderWorkerActivityGroup: GroupRenderer = (tools, allDone) =>
  renderWorkerInspectionGroup(tools, allDone, {
    running: "Checking activity of",
    done: "Checked activity of",
  });

const renderPromptWorkerGroup: GroupRenderer = (tools, allDone) => {
  const count = tools.length;
  return [
    [
      { text: allDone ? "Dispatched" : "Dispatching", bold: true, tone: "agent" },
      { text: " ", bold: false },
      { text: String(count), bold: true, tone: "agent" },
      { text: ` ${plural(count, "worker")}${projectDetail(tools)}`, bold: false },
    ],
  ];
};

function renderListGroup(
  tools: readonly ToolGroupSummaryTool[],
  allDone: boolean,
  noun: string,
): SummarySegment[][] {
  const count = tools.length;
  const times = count > 1 ? ` (${count}×)` : "";
  return [
    [
      { text: allDone ? "Listed" : "Listing", bold: true, tone: "state" },
      { text: ` ${noun}${times}`, bold: false },
    ],
  ];
}

const renderListWorkersGroup: GroupRenderer = (tools, allDone) =>
  renderListGroup(tools, allDone, "workers");

const renderListTasksGroup: GroupRenderer = (tools, allDone) =>
  renderListGroup(tools, allDone, "tasks");

/**
 * Boss-specific group summary renderers, merged over ggcoder's built-ins by
 * `buildToolGroupSummary(..., bossToolGroupRenderers)`. Keyed by tool name.
 */
export const bossToolGroupRenderers: Record<string, GroupRenderer> = {
  prompt_worker: renderPromptWorkerGroup,
  get_worker_status: renderWorkerStatusGroup,
  get_worker_summary: renderWorkerSummaryGroup,
  get_worker_activity: renderWorkerActivityGroup,
  list_workers: renderListWorkersGroup,
  list_tasks: renderListTasksGroup,
};
