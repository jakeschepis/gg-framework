import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { AnimationProvider } from "@kenkaiiii/ggcoder/ui";
import { ThemeContext, loadTheme } from "@kenkaiiii/ggcoder/ui/theme";
import { TerminalSizeProvider } from "@kenkaiiii/ggcoder/ui/hooks/terminal-size";
import { stripAnsi } from "@kenkaiiii/ggcoder/ui/terminal-history-format";
import { serializeBossItemToTerminalHistory } from "./boss-terminal-history.js";
import { BossTranscriptRow } from "./boss-transcript-rows.js";
import type { BossDisplayItem } from "./boss-ui-items.js";

const groupItem: Extract<BossDisplayItem, { kind: "tool_group" }> = {
  kind: "tool_group",
  id: "g1",
  tools: [
    { toolCallId: "c1", name: "get_worker_status", args: { project: "api" }, status: "done" },
    { toolCallId: "c2", name: "get_worker_status", args: { project: "web" }, status: "done" },
    { toolCallId: "c3", name: "get_worker_status", args: { project: "cli" }, status: "done" },
  ],
};

const context = {
  theme: loadTheme("dark"),
  columns: 80,
  version: "0.0.0",
  model: "test-model",
  provider: "anthropic" as const,
  cwd: "/tmp",
};

function wrap(node: React.ReactNode): string {
  return stripAnsi(
    renderToString(
      <TerminalSizeProvider>
        <ThemeContext.Provider value={loadTheme("dark")}>
          <AnimationProvider>{node}</AnimationProvider>
        </ThemeContext.Provider>
      </TerminalSizeProvider>,
    ),
  );
}

describe("boss tool group rendering", () => {
  it("renders a combined worker-status summary in the live transcript", () => {
    const live = wrap(<BossTranscriptRow row={groupItem} />);
    expect(live).toContain("Checked");
    expect(live).toContain("3 workers");
    expect(live).toContain("api");
  });

  it("renders the same combined summary in scrollback history", () => {
    const scrollback = stripAnsi(serializeBossItemToTerminalHistory(groupItem, context));
    expect(scrollback).toContain("Checked");
    expect(scrollback).toContain("3 workers");
    // overflow projects collapse to "+N" like ggcoder
    expect(scrollback).toMatch(/api, web, \+1/);
  });
});
