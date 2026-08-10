/**
 * The footer's one-line vs two-line decision is computed TWICE: once by
 * `useChatLayoutMeasurements` (to reserve rows in the controls budget) and once
 * inside <Footer> (to pick the layout it renders). Both go through
 * `doesFooterFitOnOneLine`, so they only agree if they're fed the same inputs.
 *
 * The hook used to omit `planMode`/`autopilot`, so it always budgeted the
 * "Plan off" / "Auto off" labels while the footer measured the live ones. That
 * failed safe only because the off-labels happen to be the wider strings —
 * relabel the on-state wider and the hook UNDER-reserves and the footer overlaps
 * the transcript. These tests pin the agreement at a width where the two states
 * genuinely disagree (the 1-char "Auto on"/"Auto off" band).
 */
import React from "react";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import {
  doesFooterFitOnOneLine,
  Footer,
  getFooterContextPercent,
  getFooterRightLength,
} from "./components/Footer.js";
import { useChatLayoutMeasurements } from "./hooks/useChatLayoutMeasurements.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import { getChatControlsLayoutDecision } from "./layout-decisions.js";
import { loadTheme, ThemeContext } from "./theme/theme.js";
import { ScreenRecorder, makeRecordingStdout } from "./testing/screen-recorder.js";

const ROWS = 24;
const theme = loadTheme("dark");

/** Footer inputs shared by the hook and the rendered component. */
const footerInputs = {
  model: "claude-sonnet-5",
  tokensIn: 12_000,
  cwd: "/Users/dev/gg-framework",
  gitBranch: "main",
  planMode: false,
};

/**
 * Narrowest width that fits the one-line footer while autopilot is ON. "Auto on"
 * is exactly one char shorter than "Auto off", so at this width the decision
 * flips on the autopilot flag alone — precisely the input the hook dropped.
 */
const BOUNDARY_COLUMNS = (() => {
  const rightLen = getFooterRightLength({
    barWidth: 8,
    contextPct: getFooterContextPercent(footerInputs.model, footerInputs.tokensIn),
    modelName: "Sonnet",
    planText: "Plan off",
    autopilotText: "Auto on",
    thinkingText: "Thinking off",
  });
  const leftLen = "gg-framework".length + 2 + footerInputs.gitBranch.length + 5;
  return leftLen + rightLen + 2;
})();

/** Rows the layout budget leaves for the transcript for a given footer height. */
function viewportRowsForFooter(footerFitsOnOneLine: boolean): number {
  const { controlsRows } = getChatControlsLayoutDecision({
    rows: ROWS,
    columns: BOUNDARY_COLUMNS,
    agentRunning: false,
    activityVisible: false,
    doneStatusVisible: false,
    stallStatusVisible: false,
    exitPending: false,
    footerStatusLayout: {
      hasBackgroundTasks: false,
      hasUpdateNotice: false,
      stack: false,
      compactBackgroundTasks: false,
    },
    taskBarExpanded: false,
    footerFitsOnOneLine,
    liveToolPanelRows: 0,
  });
  return ROWS - controlsRows;
}

/** Run the layout hook once at the boundary width and hand back its result. */
function measure(autopilot: boolean): ReturnType<typeof useChatLayoutMeasurements> {
  let captured: ReturnType<typeof useChatLayoutMeasurements> | null = null;
  function Probe() {
    captured = useChatLayoutMeasurements({
      rows: ROWS,
      columns: BOUNDARY_COLUMNS,
      backgroundTaskCount: 0,
      updatePending: false,
      agentRunning: false,
      activityPhase: "idle",
      stallError: null,
      doneStatus: null,
      currentModel: footerInputs.model,
      contextUsed: footerInputs.tokensIn,
      displayedCwd: footerInputs.cwd,
      gitBranch: footerInputs.gitBranch,
      planMode: footerInputs.planMode,
      autopilot,
      exitPending: false,
      taskBarExpanded: false,
      liveToolFeedCount: 0,
    });
    return null;
  }
  const recorder = new ScreenRecorder({ columns: BOUNDARY_COLUMNS, rows: ROWS });
  const instance = render(<Probe />, {
    stdout: makeRecordingStdout(recorder),
    patchConsole: false,
  });
  instance.unmount();
  if (!captured) throw new Error("hook did not run");
  return captured;
}

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

/** Render the real <Footer> at the boundary width; return its non-blank rows. */
async function renderFooterRows(autopilot: boolean): Promise<string[]> {
  const recorder = new ScreenRecorder({ columns: BOUNDARY_COLUMNS, rows: ROWS });
  const instance = render(
    <ThemeContext.Provider value={theme}>
      <TerminalSizeProvider>
        <Footer
          model={footerInputs.model}
          tokensIn={footerInputs.tokensIn}
          cwd={footerInputs.cwd}
          gitBranch={footerInputs.gitBranch}
          planMode={footerInputs.planMode}
          autopilot={autopilot}
        />
      </TerminalSizeProvider>
    </ThemeContext.Provider>,
    {
      stdout: makeRecordingStdout(recorder),
      columns: BOUNDARY_COLUMNS,
      rows: ROWS,
      patchConsole: false,
    },
  );
  mounted.push(instance);
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
  return recorder
    .viewportLines()
    .map((line) => stripAnsi(line))
    .filter((line) => line.trim().length > 0);
}

describe("footer row budget matches the rendered footer", () => {
  it("picks a width where the autopilot label alone decides the layout", () => {
    expect(doesFooterFitOnOneLine({ ...footerInputs, columns: BOUNDARY_COLUMNS })).toBe(false);
    expect(
      doesFooterFitOnOneLine({ ...footerInputs, autopilot: true, columns: BOUNDARY_COLUMNS }),
    ).toBe(true);
    // The two budgets must actually differ, otherwise the assertions below pass
    // for the wrong reason.
    expect(viewportRowsForFooter(true)).not.toBe(viewportRowsForFooter(false));
  });

  it("reserves one footer row when autopilot is on — the footer renders one", async () => {
    const rows = await renderFooterRows(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Auto on");
    // Before the fix the hook budgeted the wider "Auto off" label here and
    // reserved a second, never-rendered footer row.
    expect(measure(true).viewportRows).toBe(viewportRowsForFooter(true));
  });

  it("reserves two footer rows when autopilot is off — the footer renders two", async () => {
    const rows = await renderFooterRows(false);
    expect(rows).toHaveLength(2);
    expect(rows.join("\n")).toContain("Auto off");
    expect(measure(false).viewportRows).toBe(viewportRowsForFooter(false));
  });
});
