import { useCallback, useEffect, useRef, useState } from "react";
import { type DOMElement } from "ink";
import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ContextWindowOptions } from "../../core/model-registry.js";
import { doesFooterFitOnOneLine } from "../components/Footer.js";
import {
  getFooterStatusLayoutDecision,
  type FooterStatusLayoutDecision,
} from "../components/BackgroundTasksBar.js";
import {
  getChatControlsLayoutDecision,
  MIN_LIVE_AREA_ROWS,
  type DoneStatus,
} from "../layout-decisions.js";

interface UseChatLayoutMeasurementsOptions {
  rows: number;
  columns: number;
  backgroundTaskCount: number;
  updatePending: boolean;
  agentRunning: boolean;
  activityPhase: string;
  stallError: unknown;
  doneStatus: DoneStatus | null;
  currentModel: string;
  contextUsed: number;
  contextWindowOptions?: ContextWindowOptions;
  displayedCwd: string;
  gitBranch?: string | null;
  thinkingLevel?: ThinkingLevel;
  /**
   * Plan/autopilot flags exist here for ONE reason: the footer's one-line vs
   * two-line decision is width-sensitive to its own segment labels, and the
   * reserved row count computed here must match what <Footer> actually renders.
   * Pass the same values you pass to the Footer — omitting them re-introduces
   * the drift where the budget assumed the "off" labels.
   */
  planMode?: boolean;
  autopilot?: boolean;
  exitPending: boolean;
  taskBarExpanded: boolean;
  /** Current LiveToolPanel feed length; the panel renders min(count, 3) rows. */
  liveToolFeedCount: number;
  /**
   * True while autopilot's Ken review is in flight. That model call is NOT
   * driven by the agent loop, so `agentRunning`/`activityPhase` stay idle and
   * the normal spinner never appears — this claims the (always-reserved) status
   * slot instead, which is why it costs zero extra rows.
   */
  autopilotReviewing?: boolean;
}

interface ChatLayoutMeasurements {
  footerStatusLayout: FooterStatusLayoutDecision;
  activityVisible: boolean;
  stallStatusVisible: boolean;
  doneStatusVisible: boolean;
  /** Status slot shows the autopilot review spinner this frame. */
  autopilotStatusVisible: boolean;
  statusSlotVisible: boolean;
  mainControlsRef: (node: DOMElement | null) => void;
  measuredLiveAreaRows: number;
  /**
   * Transcript region height for the fullscreen alt-screen viewport. Unlike
   * `measuredLiveAreaRows` (which subtracts a 2-row cushion to keep Ink out of
   * its fullscreen clear path in the legacy scrollback model), the fullscreen
   * viewport intentionally owns the full screen, so this is simply
   * `rows - controlsRows` (floored at MIN_LIVE_AREA_ROWS).
   */
  viewportRows: number;
}

export function useChatLayoutMeasurements({
  rows,
  columns,
  backgroundTaskCount,
  updatePending,
  agentRunning,
  activityPhase,
  stallError,
  doneStatus,
  currentModel,
  contextUsed,
  contextWindowOptions,
  displayedCwd,
  gitBranch,
  thinkingLevel,
  planMode = false,
  autopilot = false,
  exitPending,
  taskBarExpanded,
  liveToolFeedCount,
  autopilotReviewing = false,
}: UseChatLayoutMeasurementsOptions): ChatLayoutMeasurements {
  const footerStatusLayout = getFooterStatusLayoutDecision({
    columns,
    backgroundTaskCount,
    updatePending,
  });
  const activityVisible = agentRunning && activityPhase !== "idle";
  // The pinned LiveToolPanel renders for the whole active turn: as soon as the
  // feed has a tool it stays visible — including while the agent streams
  // intermediate replies between tool calls — and only disappears when the run
  // ends (activity goes idle). Keep this predicate identical to ChatInputStack's
  // render gate so the budget and the rendered rows never differ.
  const liveToolPanelVisible = activityVisible;
  const liveToolPanelRows =
    liveToolPanelVisible && liveToolFeedCount > 0 ? Math.min(liveToolFeedCount, 3) : 0;
  const stallStatusVisible = !activityVisible && !!stallError;
  // The review runs AFTER the turn, so `doneStatus` is already set — the live
  // review spinner outranks that frozen summary, otherwise the UI reads "done"
  // while a model call is still burning seconds.
  const autopilotStatusVisible = !activityVisible && !stallStatusVisible && autopilotReviewing;
  const doneStatusVisible =
    !activityVisible &&
    !stallStatusVisible &&
    !autopilotStatusVisible &&
    !!doneStatus &&
    !agentRunning;
  const statusSlotVisible =
    activityVisible || stallStatusVisible || autopilotStatusVisible || doneStatusVisible;

  const [controlsHeight, setControlsHeight] = useState(0);
  const controlsObserverRef = useRef<ResizeObserver | null>(null);
  const mainControlsRef = useCallback((node: DOMElement | null) => {
    if (controlsObserverRef.current) {
      controlsObserverRef.current.disconnect();
      controlsObserverRef.current = null;
    }
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const roundedHeight = Math.round(entry.contentRect.height);
      setControlsHeight((prev) => (roundedHeight !== prev ? roundedHeight : prev));
    });
    observer.observe(node as unknown as Element);
    controlsObserverRef.current = observer;
  }, []);
  useEffect(() => () => controlsObserverRef.current?.disconnect(), []);

  const footerFitsOnOneLine = doesFooterFitOnOneLine({
    columns,
    model: currentModel,
    tokensIn: contextUsed,
    contextWindowOptions,
    cwd: displayedCwd,
    gitBranch,
    thinkingLevel,
    planMode,
    autopilot,
  });
  const chatControlsLayout = getChatControlsLayoutDecision({
    rows,
    columns,
    agentRunning,
    activityVisible,
    doneStatusVisible,
    stallStatusVisible,
    exitPending,
    footerStatusLayout,
    taskBarExpanded,
    footerFitsOnOneLine,
    liveToolPanelRows,
  });
  // Mirror Gemini's stableControlsHeight: while a turn is active, never let the
  // measured controls height shrink (transient ResizeObserver dips would grow the
  // live budget for one frame and bounce the footer). Reset to the live value at
  // idle so legitimate shrink (e.g. background task finished) is picked up.
  const prevControlsHeightRef = useRef(0);
  const measuredControlsRows =
    controlsHeight > 0 ? controlsHeight : chatControlsLayout.controlsRows;
  // While running, take the max of: the carried-forward height, the measured
  // height, and the freshly computed formula (which now includes the live tool
  // panel rows). The formula updates synchronously with the tool feed, so it
  // acts as a proactive floor that shrinks the live area in the SAME render the
  // panel grows — beating the one-frame ResizeObserver lag that otherwise lets
  // the frame overflow the terminal and bounce the footer on each tool step.
  const stableControlsRows = agentRunning
    ? Math.max(prevControlsHeightRef.current, measuredControlsRows, chatControlsLayout.controlsRows)
    : measuredControlsRows;
  prevControlsHeightRef.current = stableControlsRows;
  // Subtract a 2-row cushion (not 1) so the total live frame stays <= rows - 1
  // even with rounding from the ResizeObserver-measured controlsHeight, keeping
  // Ink out of its fullscreen clearTerminal path that snaps the controls upward.
  const measuredLiveAreaRows = Math.max(MIN_LIVE_AREA_ROWS, rows - stableControlsRows - 2);
  const viewportRows = Math.max(MIN_LIVE_AREA_ROWS, rows - stableControlsRows);

  return {
    footerStatusLayout,
    activityVisible,
    stallStatusVisible,
    doneStatusVisible,
    autopilotStatusVisible,
    statusSlotVisible,
    mainControlsRef,
    measuredLiveAreaRows,
    viewportRows,
  };
}
