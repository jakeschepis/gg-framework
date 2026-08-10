/**
 * Autopilot's Ken review is a real model call that `useAgentLoop` knows nothing
 * about, so the normal activity spinner never fires for it. These tests pin the
 * two properties that make showing it safe:
 *
 *  1. it claims the ALWAYS-reserved status slot, so it costs zero extra rows
 *     (the live-area budget must be byte-identical reviewing vs idle);
 *  2. a real agent turn still wins the slot (autopilot's injected runs).
 */
import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { ChatStatusRow, AUTOPILOT_REVIEW_LABEL } from "./components/ChatStatusRow.js";
import { useChatLayoutMeasurements } from "./hooks/useChatLayoutMeasurements.js";
import { useTheme } from "./theme/theme.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import type { DoneStatus } from "./layout-decisions.js";

const COLUMNS = 80;

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

const doneStatus: DoneStatus = { durationMs: 1200, toolsUsed: [], verb: "Done" };

type Measurements = ReturnType<typeof useChatLayoutMeasurements>;

/** Run the layout hook once and hand the result back through a mutable box. */
function measure(opts: { agentRunning: boolean; autopilotReviewing: boolean }): Measurements {
  let captured: Measurements | null = null;
  function Probe() {
    captured = useChatLayoutMeasurements({
      rows: 24,
      columns: COLUMNS,
      backgroundTaskCount: 0,
      updatePending: false,
      agentRunning: opts.agentRunning,
      activityPhase: opts.agentRunning ? "generating" : "idle",
      stallError: null,
      doneStatus,
      currentModel: "test-model",
      contextUsed: 0,
      displayedCwd: "/tmp",
      exitPending: false,
      taskBarExpanded: false,
      liveToolFeedCount: 0,
      autopilotReviewing: opts.autopilotReviewing,
    });
    return null;
  }
  renderToString(<Probe />, { columns: COLUMNS });
  if (!captured) throw new Error("hook did not run");
  return captured;
}

function renderStatusRow(props: {
  autopilotStatusVisible: boolean;
  activityVisible: boolean;
  visible: boolean;
}): string[] {
  function Harness() {
    const theme = useTheme();
    return (
      <ChatStatusRow
        visible={props.visible}
        activityVisible={props.activityVisible}
        stallStatusVisible={false}
        autopilotStatusVisible={props.autopilotStatusVisible}
        doneStatus={doneStatus}
        columns={COLUMNS}
        theme={theme}
        activityPhase={props.activityVisible ? "generating" : "idle"}
        elapsedMs={5000}
        runStartRef={{ current: Date.now() }}
        thinkingMs={0}
        isThinking={false}
        tokenEstimate={0}
        charCountRef={{ current: 0 }}
        realTokensAccumRef={{ current: 0 }}
        activeToolNames={[]}
        planDone={0}
        planTotal={0}
        renderMarkdown
        formatDuration={(ms) => `${Math.round(ms / 1000)}s`}
      />
    );
  }
  const output = renderToString(
    <TerminalSizeProvider>
      <Harness />
    </TerminalSizeProvider>,
    { columns: COLUMNS },
  );
  return stripAnsi(output).split("\n").filter(Boolean);
}

describe("autopilot review status", () => {
  it("claims the status slot while reviewing", () => {
    const reviewing = measure({ agentRunning: false, autopilotReviewing: true });
    expect(reviewing.autopilotStatusVisible).toBe(true);
    expect(reviewing.statusSlotVisible).toBe(true);
    // The frozen "Done" summary must not sit on top of an in-flight model call.
    expect(reviewing.doneStatusVisible).toBe(false);
  });

  it("costs zero rows — the status slot is reserved either way", () => {
    const idle = measure({ agentRunning: false, autopilotReviewing: false });
    const reviewing = measure({ agentRunning: false, autopilotReviewing: true });
    expect(reviewing.measuredLiveAreaRows).toBe(idle.measuredLiveAreaRows);
    expect(reviewing.viewportRows).toBe(idle.viewportRows);
  });

  it("yields to a live agent turn (autopilot's injected runs)", () => {
    const running = measure({ agentRunning: true, autopilotReviewing: true });
    expect(running.activityVisible).toBe(true);
    expect(running.autopilotStatusVisible).toBe(false);
  });

  it("renders the review label on a single row", () => {
    const lines = renderStatusRow({
      autopilotStatusVisible: true,
      activityVisible: false,
      visible: true,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(AUTOPILOT_REVIEW_LABEL);
    // Stale per-turn counters must not ride along with the review row.
    expect(lines[0]).not.toContain("tokens");
  });

  it("clears back to the done summary when the review finishes", () => {
    const lines = renderStatusRow({
      autopilotStatusVisible: false,
      activityVisible: false,
      visible: true,
    });
    expect(lines.join("\n")).not.toContain(AUTOPILOT_REVIEW_LABEL);
    expect(lines.join("\n")).toContain("Done");
  });
});
