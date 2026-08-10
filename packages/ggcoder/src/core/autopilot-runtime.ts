/**
 * Autopilot runtime helpers shared by every autopilot host (the gg-app sidecar
 * and the terminal UI).
 *
 * The cycle's control flow lives in `autopilot-cycle.ts`, the gate in
 * `autopilot-gate.ts`, and the verdict parser in `autopilot-verdict.ts`. What
 * remained sidecar-local was the *runtime* wiring every host needs verbatim:
 * the reviewer's read-only tool allow-list, how to read Ken's final reply, the
 * round cap, and how to load the project's workflow-command specs. Those live
 * here so the TUI reuses the exact same values instead of forking them.
 */
import type { Message } from "@kenkaiiii/gg-ai";
import { PROMPT_COMMANDS } from "./prompt-commands.js";
import { loadCustomCommands } from "./custom-commands.js";
import type { WorkflowCommandSpec } from "./autopilot-gate.js";

/** Ken's read-only tool allow-list. Excludes every mutating tool (write/edit/
 *  bash/tasks/subagent/generate_image/enter_plan/exit_plan/task_*) so the mentor
 *  agent can research + see, but never change the repo. */
export const KEN_ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "source_path",
  "web_fetch",
  "web_search",
  "screenshot",
];

/** MCP servers Ken is allowed to use. kencode-search lets him look into real
 *  public repos / verify against actual code instead of assuming — core to how
 *  he's meant to work. Read-only research; no other MCP server is connected. */
export const KEN_ALLOWED_MCP_SERVERS = ["kencode-search"];

/** Hard cap on review→prompt→review rounds per user turn (loop safety). A
 *  plan-pending cycle widens this by +2 (approve+implement and the
 *  post-implement review each consume a round). */
export const MAX_AUTOPILOT_ROUNDS = 3;

/** Re-exported so every Node-side host keeps importing it from here. The literal
 *  itself lives in the zero-import leaf `plan-prompt.ts` because the gg-app
 *  webview shares it too and cannot import this module (it reaches
 *  `node:fs/promises` through `custom-commands.js`). */
export { IMPLEMENT_PLAN_PROMPT } from "./plan-prompt.js";

/** Extract the plain text of the most recent assistant message (Ken's reply).
 *  Strips tool-call / image blocks, returning just the prose Ken streamed. */
export function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    return m.content
      .map((c) => (c.type === "text" && "text" in c && typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

/** Workflow (prompt-template) commands: built-in + the project's custom
 *  `.gg/commands/*.md`. Used to gate autopilot off command turns and to label
 *  expanded templates in Ken's digests. Loaded fresh so a newly added custom
 *  command is picked up without a restart (mirrors GET /commands). */
export async function loadWorkflowCommandSpecs(cwd: string): Promise<WorkflowCommandSpec[]> {
  const custom = await loadCustomCommands(cwd).catch(() => []);
  return [
    ...PROMPT_COMMANDS.map((c) => ({ name: c.name, aliases: c.aliases, prompt: c.prompt })),
    ...custom.map((c) => ({ name: c.name, aliases: [] as string[], prompt: c.prompt })),
  ];
}
