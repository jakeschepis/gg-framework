import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";

/**
 * A single recorded tool invocation. The rubric scorers read this trajectory
 * (not the model's prose) to judge behavior — e.g. "did it read before edit?".
 */
export interface TrajectoryEntry {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Result preview, truncated. */
  result: string;
}

export interface Sandbox {
  root: string;
  trajectory: TrajectoryEntry[];
  tools: AgentTool[];
  cleanup: () => void;
}

/** Reject any path that escapes the sandbox root after resolution. */
function jail(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes sandbox: ${p}`);
  }
  return abs;
}

function record(
  trajectory: TrajectoryEntry[],
  tool: string,
  args: Record<string, unknown>,
  fn: () => string,
): string {
  try {
    const result = fn();
    trajectory.push({ tool, args, ok: true, result: result.slice(0, 400) });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trajectory.push({ tool, args, ok: false, result: msg.slice(0, 400) });
    return `Error: ${msg}`;
  }
}

/**
 * Build a jailed toolset rooted at a fresh temp dir, seeded with `seedFiles`.
 * bash runs with cwd=root, so destructive commands (`rm -rf`, etc.) can only
 * damage the throwaway sandbox — they can't touch the real repo.
 */
export function createSandbox(seedFiles: Record<string, string>): Sandbox {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".bench-sandbox-"));
  for (const [rel, content] of Object.entries(seedFiles)) {
    const dest = jail(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  const trajectory: TrajectoryEntry[] = [];

  // Descriptions are copied verbatim from the production tools/*.ts schema so
  // the bench measures the real "schema vs prompt-hint" tradeoff. The model
  // sees these on every turn regardless of the prompt's Tools section.
  const read: AgentTool = {
    name: "read",
    description:
      "Read a file's contents. Returns numbered lines (cat -n style). Output is truncated to 2000 lines or 50KB (whichever is hit first). If truncated, use offset/limit to read remaining sections. Binary files return a notice instead of content.",
    parameters: z.object({
      file_path: z.string(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    }),
    execute: (a) =>
      record(trajectory, "read", a as Record<string, unknown>, () =>
        fs.readFileSync(jail(root, (a as { file_path: string }).file_path), "utf-8"),
      ),
  };

  const write: AgentTool = {
    name: "write",
    description:
      "Write content to a file. Creates parent directories if needed. Existing files must be read first before overwriting. Use for new files or complete rewrites.",
    parameters: z.object({ file_path: z.string(), content: z.string() }),
    execute: (a) =>
      record(trajectory, "write", a as Record<string, unknown>, () => {
        const { file_path, content } = a as { file_path: string; content: string };
        const dest = jail(root, file_path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        return `Wrote ${content.length} bytes to ${file_path}`;
      }),
  };

  const edit: AgentTool = {
    name: "edit",
    description:
      "Replace text in a file via { old_text, new_text } edits applied sequentially. Read the file first and copy old_text from the latest read/diff. Each old_text should identify one location — include surrounding context; set replace_all: true only for deliberate global replacements/renames. The matcher tolerates safe whitespace/quote/dash drift, but do not paraphrase. Returns a unified diff.",
    parameters: z.object({
      file_path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
    }),
    execute: (a) =>
      record(trajectory, "edit", a as Record<string, unknown>, () => {
        const { file_path, old_text, new_text } = a as {
          file_path: string;
          old_text: string;
          new_text: string;
        };
        const dest = jail(root, file_path);
        const cur = fs.readFileSync(dest, "utf-8");
        if (!cur.includes(old_text)) throw new Error("old_text not found");
        fs.writeFileSync(dest, cur.replace(old_text, new_text));
        return `Edited ${file_path}`;
      }),
  };

  const ls: AgentTool = {
    name: "ls",
    description: "List directory contents with file types and sizes. Directories listed first.",
    parameters: z.object({ path: z.string().optional() }),
    execute: (a) =>
      record(trajectory, "ls", a as Record<string, unknown>, () => {
        const target = jail(root, (a as { path?: string }).path ?? ".");
        return fs.readdirSync(target).join("\n") || "(empty)";
      }),
  };

  const find: AgentTool = {
    name: "find",
    description:
      "Find files matching a glob pattern. Respects .gitignore. Returns sorted file paths, truncated if more than 100 matches.",
    parameters: z.object({ pattern: z.string(), path: z.string().optional() }),
    execute: (a) =>
      record(trajectory, "find", a as Record<string, unknown>, () => {
        const { pattern } = a as { pattern: string };
        // Minimal glob: support "**/*.ext" and "*.ext" and plain names via shell.
        const out = execFileSync(
          "bash",
          ["-c", `find . -type f -name '${pattern.replace(/.*\//, "")}' | sed 's|^\\./||' | sort`],
          { cwd: root, encoding: "utf-8", timeout: 10_000 },
        );
        return out.trim() || "(no matches)";
      }),
  };

  const grep: AgentTool = {
    name: "grep",
    description:
      "Search file contents using regex. Returns filepath:line_number:content for matches. Respects .gitignore. Skips binary files.",
    parameters: z.object({ pattern: z.string(), path: z.string().optional() }),
    execute: (a) =>
      record(trajectory, "grep", a as Record<string, unknown>, () => {
        const { pattern } = a as { pattern: string };
        try {
          const out = execFileSync("bash", ["-c", `grep -rn -- '${pattern}' . || true`], {
            cwd: root,
            encoding: "utf-8",
            timeout: 10_000,
          });
          return out.trim() || "(no matches)";
        } catch {
          return "(no matches)";
        }
      }),
  };

  const bash: AgentTool = {
    name: "bash",
    description:
      "Execute a bash command. The shell's working directory is already set to the project root. Returns exit code and combined stdout/stderr. Use for computation and long/background processes, not direct file rewrites.",
    parameters: z.object({ command: z.string() }),
    execute: (a) =>
      record(trajectory, "bash", a as Record<string, unknown>, () => {
        const { command } = a as { command: string };
        try {
          return (
            execFileSync("bash", ["-c", command], {
              cwd: root,
              encoding: "utf-8",
              timeout: 15_000,
              stdio: ["ignore", "pipe", "pipe"],
            }) || "(no output)"
          );
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message: string };
          return `exit nonzero\n${e.stdout ?? ""}\n${e.stderr ?? e.message}`;
        }
      }),
  };

  return {
    root,
    trajectory,
    tools: [read, write, edit, ls, find, grep, bash],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
