import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { isPlanModeActive } from "../core/runtime-mode.js";

const EnterPlanParams = z.object({
  reason: z
    .string()
    .optional()
    .describe("Why you are entering plan mode, e.g. a complex multi-file task"),
});

export function createEnterPlanTool(
  onEnterPlan: (reason?: string) => void | Promise<void>,
  planModeRef?: { current: boolean },
): AgentTool<typeof EnterPlanParams> {
  return {
    name: "enter_plan",
    description:
      "Enter plan mode for safe, read-only exploration before making changes. " +
      "Use this when a complex or risky task benefits from research and an explicit plan. " +
      "In plan mode, bash, edit, subagent, and normal writes are restricted; write is only allowed under .gg/plans/.",
    parameters: EnterPlanParams,
    executionMode: "sequential",
    async execute({ reason }) {
      if (isPlanModeActive(planModeRef)) {
        return "Already in plan mode — continue your research. Draft the plan in .gg/plans/<name>.md and call exit_plan when ready.";
      }
      await onEnterPlan(reason);
      return (
        "Plan mode activated. You are now in read-only research mode.\n\n" +
        "Allowed actions:\n" +
        "- Use read, grep, find, ls, source_path, web_fetch/web_search, and code search tools to investigate\n" +
        "- Write the implementation plan to .gg/plans/<name>.md\n\n" +
        "Restricted: bash, edit, write outside .gg/plans/, subagent, and task mutation.\n\n" +
        "When the plan is ready, call exit_plan with the plan file path."
      );
    },
  };
}
