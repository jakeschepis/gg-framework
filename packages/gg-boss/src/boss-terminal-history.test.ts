import { describe, expect, it } from "vitest";
import { stripAnsi } from "@kenkaiiii/ggcoder/ui/terminal-history-format";
import { loadTheme } from "@kenkaiiii/ggcoder/ui/theme";
import {
  createBossTerminalHistoryPrinter,
  serializeBossItemToTerminalHistory,
} from "./boss-terminal-history.js";
import type { BossDisplayItem } from "./boss-ui-items.js";

const context = {
  theme: loadTheme("dark"),
  columns: 80,
  version: "0.0.0",
  model: "test-model",
  provider: "anthropic" as const,
  cwd: "/tmp",
};

describe("boss terminal history", () => {
  it("dedupes finalized rows after synchronous user print", () => {
    const writes: string[] = [];
    const printer = createBossTerminalHistoryPrinter();
    const user: BossDisplayItem = { kind: "user", id: "u1", text: "Ship it", timestamp: 1 };

    printer.print([user], context, { write: (data) => writes.push(data) });
    printer.print([user], context, { write: (data) => writes.push(data) });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("Ship it");
  });

  it("can reset dedupe before repainting durable history on resize", () => {
    const writes: string[] = [];
    const printer = createBossTerminalHistoryPrinter();
    const user: BossDisplayItem = { kind: "user", id: "u1", text: "Resize me", timestamp: 1 };

    printer.print([user], context, { write: (data) => writes.push(data) });
    printer.resetPrinted();
    printer.print([user], context, { write: (data) => writes.push(data) });

    expect(writes).toHaveLength(2);
  });

  it("serializes shared chat rows with gg-coder finalized-history chrome", () => {
    const user: BossDisplayItem = { kind: "user", id: "u1", text: "Ship it", timestamp: 1 };
    const assistant: BossDisplayItem = {
      kind: "assistant",
      id: "a1",
      text: "Hello **boss**",
      durationMs: 1,
    };
    const tool: BossDisplayItem = {
      kind: "tool_done",
      id: "t1",
      name: "bash",
      args: { command: "printf hi" },
      result: "Exit code: 0\nhi",
      isError: false,
      durationMs: 1,
    };

    const userOutput = stripAnsi(serializeBossItemToTerminalHistory(user, context));
    const assistantOutput = stripAnsi(serializeBossItemToTerminalHistory(assistant, context));
    const toolOutput = stripAnsi(serializeBossItemToTerminalHistory(tool, context));

    expect(userOutput.split("\n")[0]).toBe("▄".repeat(context.columns));
    expect(userOutput).toContain("> Ship it");
    expect(userOutput.split("\n")[2]).toBe("▀".repeat(context.columns));
    expect(assistantOutput).toMatch(/^ [⏺●] Hello boss/);
    expect(toolOutput).toContain("Bash(printf hi)");
    expect(toolOutput).toContain("  ⎿  hi");
  });

  it("matches gg-coder spacing between assistant and boss tool rows", () => {
    const writes: string[] = [];
    const printer = createBossTerminalHistoryPrinter();
    const items: BossDisplayItem[] = [
      { kind: "assistant", id: "a1", text: "I’ll list the workers.", durationMs: 1 },
      {
        kind: "tool_done",
        id: "t1",
        name: "list_workers",
        args: {},
        result: "- app: idle\n- api: idle",
        isError: false,
        durationMs: 1,
      },
    ];

    printer.print(items, context, { write: (data) => writes.push(data) });

    const output = stripAnsi(writes.join(""));
    expect(output).toMatch(new RegExp("list the workers\\.\\n\\n [⏺●] List Workers"));
  });

  it("spaces consecutive boss assistant responses", () => {
    const writes: string[] = [];
    const printer = createBossTerminalHistoryPrinter();
    const items: BossDisplayItem[] = [
      { kind: "assistant", id: "a1", text: "First response.", durationMs: 1 },
      { kind: "assistant", id: "a2", text: "Second response.", durationMs: 1 },
    ];

    printer.print(items, context, { write: (data) => writes.push(data) });

    const output = stripAnsi(writes.join(""));
    expect(output).toMatch(new RegExp("First response\\.\\n\\n [⏺●] Second response\\."));
  });

  it("separates Boss-only worker events and keeps them to one header line", () => {
    const writes: string[] = [];
    const printer = createBossTerminalHistoryPrinter();
    const items: BossDisplayItem[] = [
      { kind: "user", id: "u1", text: "Run workers", timestamp: 1 },
      { kind: "assistant", id: "a1", text: "Starting.", durationMs: 1 },
      {
        kind: "worker_event",
        id: "w1",
        project: "app",
        status: "idle",
        finalText: "Changed: src/app.ts Verified: pnpm test Status: DONE",
        toolsUsed: [{ name: "edit", ok: true }],
        turnIndex: 1,
        timestamp: "now",
      },
    ];

    printer.print(items, context, { write: (data) => writes.push(data) });

    const output = stripAnsi(writes.join(""));
    expect(output).toContain("Starting.");
    expect(output).toMatch(new RegExp("Starting\\.\\n\\n [⏺●] app {2}turn 1 {2}· {2}DONE"));
    expect(output).not.toContain("  ⎿  ");
    expect(output).not.toContain("Changed:");
  });
});
