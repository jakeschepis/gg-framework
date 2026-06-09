/**
 * Tool-hints ablation.
 *
 * Question: the `## Tools` section in the system prompt lists a one-line hint
 * per tool. Every tool ALSO ships a rich schema `description` the model sees on
 * every turn regardless of the prompt. Does the prompt hint section add
 * anything to tool SELECTION, or is it redundant with the schema descriptions?
 *
 * Three prompt conditions, same sandbox tools (which carry the real production
 * schema descriptions):
 *   - full     : the current per-tool hint list
 *   - none     : no Tools section at all (schema-only)
 *   - steering : only the cross-tool preferences a single schema can't state
 *
 * We score whether the model picks the RIGHT tool for each task.
 */
import { Agent, type AgentEvent } from "@kenkaiiii/gg-agent";
import { loadAuth } from "./auth.js";
import { createSandbox, type TrajectoryEntry } from "./sandbox.js";

interface ToolsVariant {
  id: string;
  words: number;
  text: string;
}

const BASE_PROMPT =
  "You are GG Coder, a coding agent working in the user's codebase. Use the available tools to complete the task.";

function w(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

const HINTS_FULL = `## Tools

- **read**: Read file contents. Use offset/limit for large files.
- **write**: Create or overwrite files; read existing files first. Prefer edit for changes.
- **edit**: Apply surgical { old_text, new_text } edits from a prior read. Use exact text; retry only failed edits; replace_all for renames.
- **bash**: Run shell commands from project root; use for computation and long/background processes, not direct file rewrites.
- **find**: Find files/dirs by name pattern. Faster than bash find, respects .gitignore.
- **grep**: Regex search across files. Use for usages, definitions, imports.
- **ls**: List directory contents with file types and sizes.`;

// Only the cross-tool preferences no single tool's own description states.
const HINTS_STEERING = `## Tool preferences

Prefer \`edit\` over \`write\` for changes to existing files. Use \`find\`/\`grep\` rather than \`bash\` for locating files and searching content.`;

export const TOOLS_VARIANTS: ToolsVariant[] = [
  { id: "hints.full", words: w(HINTS_FULL), text: HINTS_FULL },
  { id: "hints.none", words: 0, text: "" },
  { id: "hints.steering", words: w(HINTS_STEERING), text: HINTS_STEERING },
];

// ── Tool-selection tasks ───────────────────────────────────
interface SelectTask {
  id: string;
  prompt: string;
  seed: Record<string, string>;
  /** Right-tool check over the trajectory. */
  pass: (t: TrajectoryEntry[]) => boolean;
}

function used(t: TrajectoryEntry[], tool: string, match?: (e: TrajectoryEntry) => boolean): boolean {
  return t.some((e) => e.tool === tool && (!match || match(e)));
}

const TASKS: SelectTask[] = [
  {
    id: "edit-not-write",
    prompt: "Change the version in version.txt from 1.0.0 to 2.0.0.",
    seed: { "version.txt": "1.0.0\n" },
    // Right: edit (surgical). Wrong: write (full overwrite) or bash redirect.
    pass: (t) =>
      used(t, "edit", (e) => String(e.args.file_path ?? "").includes("version.txt")) &&
      !used(t, "write", (e) => String(e.args.file_path ?? "").includes("version.txt")),
  },
  {
    id: "find-not-bash",
    prompt: "Find every .config file in this project and list their paths.",
    seed: {
      "a.config": "x\n",
      "sub/b.config": "y\n",
      "sub/deep/c.config": "z\n",
      "readme.md": "hi\n",
    },
    // Right: find/grep tool. Wrong: bash find/ls.
    pass: (t) =>
      (used(t, "find") || used(t, "grep")) &&
      !used(t, "bash", (e) => /\bfind\b|\bls\b/.test(String(e.args.command ?? ""))),
  },
  {
    id: "grep-not-bash",
    prompt: "Where is the function `computeTotal` defined? Search the codebase.",
    seed: {
      "src/math.js": "function computeTotal(a, b) {\n  return a + b;\n}\n",
      "src/other.js": "function noop() {}\n",
    },
    pass: (t) =>
      used(t, "grep") &&
      !used(t, "bash", (e) => /\bgrep\b/.test(String(e.args.command ?? ""))),
  },
  {
    id: "read-before-edit",
    prompt: "In app.js, rename the variable `foo` to `bar` everywhere.",
    seed: { "app.js": "const foo = 1;\nconsole.log(foo);\nreturn foo + foo;\n" },
    // Right: read first, then edit. Selection check: used read then edit.
    pass: (t) => {
      const r = t.findIndex((e) => e.tool === "read");
      const ed = t.findIndex((e) => e.tool === "edit");
      return r >= 0 && ed >= 0 && r < ed;
    },
  },
];

async function runOnce(variant: ToolsVariant, task: SelectTask): Promise<TrajectoryEntry[]> {
  const auth = await loadAuth("anthropic");
  const sandbox = createSandbox(task.seed);
  try {
    const system = variant.text ? `${BASE_PROMPT}\n\n${variant.text}` : BASE_PROMPT;
    const agent = new Agent({
      provider: "anthropic",
      model: "claude-opus-4-8",
      system,
      tools: sandbox.tools,
      apiKey: auth.apiKey,
      maxTurns: 12,
      maxTokens: 4096,
      thinking: "low",
    });
    const stream = agent.prompt(task.prompt);
    for await (const ev of stream as AsyncIterable<AgentEvent>) {
      if (ev.type === "error") throw ev.error;
    }
    return sandbox.trajectory;
  } finally {
    sandbox.cleanup();
  }
}

async function main(): Promise<void> {
  process.on("unhandledRejection", () => {});
  const iterations = Number(process.argv[process.argv.indexOf("-n") + 1]) || 10;
  console.log(`tool-hints ablation — ${iterations} iterations/cell · opus\n`);

  for (const task of TASKS) {
    console.log(`task ${task.id}`);
    for (const variant of TOOLS_VARIANTS) {
      let pass = 0;
      let n = 0;
      let err = 0;
      for (let i = 0; i < iterations; i++) {
        try {
          const traj = await runOnce(variant, task);
          if (task.pass(traj)) pass++;
          n++;
        } catch {
          err++;
        }
      }
      const pct = n ? `${Math.round((pass / n) * 100)}%`.padStart(4) : "  - ";
      console.log(
        `  ${variant.id.padEnd(16)} ${String(variant.words).padStart(3)}w  n=${n}${err ? `(+${err}e)` : ""}  right-tool=${pct}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
