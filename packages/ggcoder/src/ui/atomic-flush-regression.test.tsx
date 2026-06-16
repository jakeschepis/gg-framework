// Full-lifecycle regression for the atomic transcript flush.
//
// Models a complete turn on the native-scrollback default: idle → tall
// streaming response → live tool panel grows under the controls → done. The
// done transition finalizes the turn the way App does: queueFlush renders the
// transcript to ANSI and enqueues it through the patched Ink
// `insertBeforeFrame` while — in the SAME React batch — the live frame shrinks
// (streamed text flushed, tool panel hidden, activity → done swap). The
// resulting single frame write is `erase tall frame + scrollback bytes +
// shorter frame`, so:
//   (a) Ink's full-screen repaint (eraseScreen + cursorTo top) never fires,
//   (b) the footer never moves UP in the terminal buffer, and
//   (c) the controls sit directly under the last transcript row after done —
//       no stranded blank gap.
import React, { useEffect, useRef, useState } from "react";
import { render, Text, useStdout } from "ink";
import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import type { CompletedItem } from "./app-items.js";
import { ChatControls, ChatLayout } from "./components/ChatLayout.js";
import { ChatLivePane } from "./components/ChatLivePane.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import { renderTranscriptItem } from "./transcript/TranscriptRenderer.js";
import { loadTheme, ThemeContext } from "./theme/theme.js";
import { createTerminalHistoryPrinter } from "./terminal-history.js";
import type { TerminalHistoryContext } from "./terminal-history.js";
import { useTranscriptHistory } from "./hooks/useTranscriptHistory.js";
import { ScreenRecorder, makeRecordingStdout } from "./testing/screen-recorder.js";

const COLUMNS = 80;
const ROWS = 24;
const theme = loadTheme("dark");
const terminalContext: TerminalHistoryContext = {
  theme,
  columns: COLUMNS,
  version: "sim",
  model: "sim-model",
  provider: "anthropic",
  cwd: "/tmp/sim-project",
};

const FOOTER_BOTTOM = "SIM_ACTIVITY_BAR";
const TOOL_PANEL_ROWS = 4;
// Live-area budget: terminal rows minus the worst-case controls block (tool
// panel + status + input + footer rows). Mirrors App's layout measurement —
// the clamp is what keeps Ink out of its full-screen tall-frame repaint path.
const LIVE_AREA_BUDGET = ROWS - (TOOL_PANEL_ROWS + 4) - 2;

// Taller than the live-area budget, so streaming engages the clamp and the
// final flush writes more scrollback rows than the live region ever showed.
const longResponse = Array.from(
  { length: ROWS - 6 },
  (_, i) => `SIM_LINE_${String(i + 1).padStart(2, "0")}`,
).join("\n");

function SimulatedControls({ running, toolRows }: { running: boolean; toolRows: number }) {
  return (
    <ChatControls controlsRef={() => {}}>
      {Array.from({ length: toolRows }, (_, i) => (
        <Text key={`tool-${i}`}>{`SIM_TOOL_${i + 1}`}</Text>
      ))}
      <Text>{running ? "SIM_STREAMING" : "SIM_DONE"}</Text>
      <Text>SIM_INPUT</Text>
      <Text>SIM_FOOTER</Text>
      <Text>{FOOTER_BOTTOM}</Text>
    </ChatControls>
  );
}

type Phase = "idle" | "stream" | "tools" | "done";

interface ViewState {
  running: boolean;
  streamingText: string;
  toolRows: number;
}

function Driver({ phase, enqueueStdout }: { phase: Phase; enqueueStdout: (data: string) => void }) {
  const { write: writeStdout } = useStdout();
  const [history, setHistory] = useState<CompletedItem[]>([]);
  const [liveItems, setLiveItems] = useState<CompletedItem[]>([]);
  // All visuals derive from internal state so the done transition can swap
  // EVERYTHING (flush + streamed text removal + panel hide + activity → done)
  // in one effect — i.e. one React batch — exactly like useAgentLoop's onDone.
  const [view, setView] = useState<ViewState>({ running: false, streamingText: "", toolRows: 0 });
  const committedRef = useRef(false);
  // Stable printer across renders — mirrors renderApp, where one printer
  // instance (and its printed-id dedup set) lives for the whole app lifetime.
  const printerRef = useRef<ReturnType<typeof createTerminalHistoryPrinter> | null>(null);
  printerRef.current ??= createTerminalHistoryPrinter();
  const { queueFlush } = useTranscriptHistory({
    terminalHistoryPrinter: printerRef.current,
    terminalHistoryContext: terminalContext,
    writeStdout,
    enqueueStdout,
    sessionPathRef: { current: undefined },
    sessionManagerRef: { current: null },
    history,
    setHistory,
    setLiveItems,
  });

  // Idempotent setter: queueFlush is referentially unstable across renders
  // (it lives in the hook's render scope), so this effect re-runs every
  // commit. Returning the previous object when nothing changed keeps React
  // from looping ("Maximum update depth exceeded") on the stream/tools
  // phases, which set the same view on every run.
  const applyView = (next: ViewState): void => {
    setView((prev) =>
      prev.running === next.running &&
      prev.streamingText === next.streamingText &&
      prev.toolRows === next.toolRows
        ? prev
        : next,
    );
  };
  const applyViewRef = useRef(applyView);
  applyViewRef.current = applyView;

  useEffect(() => {
    if (phase === "idle") return;
    if (phase === "stream") {
      applyViewRef.current({ running: true, streamingText: longResponse, toolRows: 0 });
      return;
    }
    if (phase === "tools") {
      applyViewRef.current({
        running: true,
        streamingText: longResponse,
        toolRows: TOOL_PANEL_ROWS,
      });
      return;
    }
    if (committedRef.current) return;
    committedRef.current = true;
    // Finalize the turn: enqueue the transcript bytes (passive) and shrink the
    // live frame in the same batch. The next frame write carries both.
    queueFlush([{ kind: "assistant", id: "final", text: longResponse }]);
    setLiveItems([]);
    applyViewRef.current({ running: false, streamingText: "", toolRows: 0 });
  }, [phase, queueFlush]);

  const renderItem = (item: CompletedItem, index: number, items: CompletedItem[]) =>
    renderTranscriptItem({
      item,
      index,
      items,
      version: "sim",
      currentModel: "sim-model",
      currentProvider: "anthropic",
      displayedCwd: "/tmp/sim-project",
      columns: COLUMNS,
      theme,
      renderMarkdown: true,
      measuredLiveAreaRows: LIVE_AREA_BUDGET,
    });

  return (
    <ThemeContext.Provider value={theme}>
      <TerminalSizeProvider>
        <ChatLayout columns={COLUMNS}>
          <ChatLivePane
            liveItems={liveItems}
            renderItem={renderItem}
            isRunning={view.running}
            visibleStreamingText={view.streamingText}
            streamingThinking=""
            thinkingMs={0}
            reserveStreamingSpacing={false}
            renderMarkdown
            measuredLiveAreaRows={LIVE_AREA_BUDGET}
            assistantMarginTop={0}
            streamingContinuation={false}
          />
          <SimulatedControls running={view.running} toolRows={view.toolRows} />
        </ChatLayout>
      </TerminalSizeProvider>
    </ThemeContext.Provider>
  );
}

const ERASE_SCREEN = "\u001B[2J";

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
}

describe("atomic transcript flush lifecycle", () => {
  it("finalizes a tool-heavy turn without repaints, footer rises, or gaps", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const baseStdout = makeRecordingStdout(recorder);
    const sink = { raw: "" };
    const stdout = new Proxy(baseStdout, {
      get(target, prop, receiver) {
        if (prop === "write") {
          return (chunk: string, cb?: (error?: Error | null) => void) => {
            sink.raw += chunk;
            return target.write(chunk, cb);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as NodeJS.WriteStream;

    // Mirrors renderApp's enqueueHistoryWrite: read the (patched) instance at
    // call time, fall back to a raw write when the API is unavailable.
    const instanceRef: { current: { insertBeforeFrame?: (data: string) => void } | null } = {
      current: null,
    };
    const enqueueStdout = (data: string): void => {
      if (instanceRef.current?.insertBeforeFrame) {
        instanceRef.current.insertBeforeFrame(data);
      } else {
        stdout.write(data);
      }
    };

    const frames: { label: string; full: string }[] = [];
    const capture = (label: string): void => {
      frames.push({ label, full: stripAnsi(recorder.fullText()) });
    };

    const mounted = render(<Driver phase="idle" enqueueStdout={enqueueStdout} />, {
      stdout,
      columns: COLUMNS,
      rows: ROWS,
      patchConsole: false,
      maxFps: 1000,
    });
    instanceRef.current = mounted as unknown as { insertBeforeFrame?: (data: string) => void };
    await tick();
    capture("idle");

    mounted.rerender(<Driver phase="stream" enqueueStdout={enqueueStdout} />);
    await tick();
    capture("tall streaming");

    mounted.rerender(<Driver phase="tools" enqueueStdout={enqueueStdout} />);
    await tick();
    capture("tool panel grows");

    mounted.rerender(<Driver phase="done" enqueueStdout={enqueueStdout} />);
    await tick();
    capture("done, first settle");
    await tick();
    capture("done, settled");

    mounted.unmount();

    // (a) Zero full-screen repaints (eraseScreen + cursorTo top) across the
    // whole lifecycle — the clamp keeps Ink out of its tall-frame path, and
    // the atomic insert keeps the shrink from ever needing a repaint.
    expect(sink.raw.split(ERASE_SCREEN).length - 1, "full-screen repaints").toBe(0);

    // (b) The footer's absolute row in the terminal buffer never moves UP.
    // Scrollback growth pushes it down; an upward move means a shrink-write
    // landed without its compensating scrollback bytes.
    let previousFooterRow = -1;
    for (const f of frames) {
      const footerRow = f.full.split("\n").findIndex((line) => line.includes(FOOTER_BOTTOM));
      expect(footerRow, `${f.label}: footer present`).toBeGreaterThanOrEqual(0);
      expect(
        footerRow,
        `${f.label}: footer buffer row never decreases (was ${previousFooterRow})`,
      ).toBeGreaterThanOrEqual(previousFooterRow);
      previousFooterRow = footerRow;
    }

    // (c) After done: the controls sit directly under the last transcript row —
    // no stranded blank rows between the flushed response and the controls.
    const settled = frames.at(-1)!;
    const lines = settled.full.split("\n");
    const lastTranscriptRow = lines.reduce(
      (acc, line, i) => (line.includes("SIM_LINE_") ? i : acc),
      -1,
    );
    const controlsRow = lines.findIndex((line) => line.includes("SIM_DONE"));
    expect(lastTranscriptRow, "flushed transcript present after done").toBeGreaterThanOrEqual(0);
    expect(controlsRow, "controls present after done").toBeGreaterThan(lastTranscriptRow);
    const between = lines.slice(lastTranscriptRow + 1, controlsRow);
    expect(
      between.filter((line) => line.trim().length === 0).length,
      "no blank gap between transcript and controls",
    ).toBe(0);

    // And the flushed response must never be duplicated (scrollback + live).
    for (const f of frames) {
      const occurrences = f.full.split("SIM_LINE_01").length - 1;
      expect(occurrences, `${f.label}: flushed content not duplicated`).toBeLessThanOrEqual(1);
    }
  });
});
