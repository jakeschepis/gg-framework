// Regression for the per-chunk footer "bounce" during streaming.
//
// The assistant response is flushed to native scrollback paragraph-by-paragraph
// while it streams (see assistant-stream-split). The flush effect calls
// queueFlush, which renders the paragraph to ANSI and enqueues the bytes
// through the patched Ink `insertBeforeFrame` (a passive buffer — no terminal
// write), then advances `flushedChars` via the same React batch. The commit
// that shrinks the live text therefore carries the compensating scrollback
// bytes in ONE frame write: erase tall frame + paragraph bytes + shorter
// frame. No frame ever shows the paragraph in both scrollback and the live
// region, so the footer offset from the bottom stays constant. This test
// models that flow and asserts exactly that.
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
import { splitAssistantStreamingText } from "./utils/assistant-stream-split.js";
import { stripDoneMarkers } from "../utils/plan-steps.js";

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

let idCounter = 0;
const getId = (): string => `chunk-${idCounter++}`;

function Controls(): React.ReactElement {
  return (
    <ChatControls controlsRef={() => {}}>
      <Text>SIM_STATUS</Text>
      <Text>SIM_INPUT</Text>
      <Text>SIM_FOOTER</Text>
      <Text>{FOOTER_BOTTOM}</Text>
    </ChatControls>
  );
}

// Mirrors App.tsx: the live text is sliced by the COMMITTED `flushedChars`
// only. The flush effect enqueues the paragraph bytes (passive) and advances
// `flushedChars`; the resulting commit's single frame write both shrinks the
// live frame and carries the scrollback bytes.
function Driver({
  rawText,
  enqueueStdout,
}: {
  rawText: string;
  enqueueStdout: (data: string) => void;
}): React.ReactElement {
  const { write: writeStdout } = useStdout();
  const [history, setHistory] = useState<CompletedItem[]>([]);
  const [liveItems, setLiveItems] = useState<CompletedItem[]>([]);
  const flushRef = useRef({ flushedChars: 0, text: "" });
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

  const alreadyFlushed = flushRef.current.flushedChars;

  useEffect(() => {
    if (!rawText) {
      flushRef.current = { flushedChars: 0, text: "" };
      return;
    }
    if (rawText === flushRef.current.text) return;
    const split = splitAssistantStreamingText(rawText.slice(flushRef.current.flushedChars));
    if (split.flushedText.length > 0) {
      queueFlush([
        {
          kind: "assistant",
          text: stripDoneMarkers(split.flushedText),
          continuation: flushRef.current.flushedChars > 0,
          id: getId(),
        },
      ]);
      flushRef.current = {
        flushedChars: flushRef.current.flushedChars + split.flushedText.length,
        text: rawText,
      };
      return;
    }
    flushRef.current = { ...flushRef.current, text: rawText };
  }, [rawText, queueFlush]);

  const visibleStreamingText = stripDoneMarkers(rawText.slice(alreadyFlushed));

  const renderItem = (
    item: CompletedItem,
    index: number,
    items: CompletedItem[],
  ): React.ReactNode =>
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
      measuredLiveAreaRows: ROWS,
    });

  return (
    <ThemeContext.Provider value={theme}>
      <TerminalSizeProvider>
        <ChatLayout columns={COLUMNS}>
          <ChatLivePane
            liveItems={liveItems}
            renderItem={renderItem}
            isRunning
            visibleStreamingText={visibleStreamingText}
            streamingThinking=""
            thinkingMs={0}
            reserveStreamingSpacing={false}
            renderMarkdown
            measuredLiveAreaRows={ROWS}
            // Mirrors App: a live continuation of an already-flushed stream
            // re-inserts the blank separator line above the live remainder.
            assistantMarginTop={alreadyFlushed > 0 ? 1 : 0}
            streamingContinuation={alreadyFlushed > 0}
          />
          <Controls />
        </ChatLayout>
      </TerminalSizeProvider>
    </ThemeContext.Provider>
  );
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
}

function paragraph(n: number): string {
  return Array.from({ length: 3 }, (_, i) => `P${n}_LINE_${i + 1}`).join("\n");
}

describe("streaming flush footer bounce", () => {
  it("keeps the footer at a constant offset across paragraph flush boundaries", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(recorder);

    // Mirrors renderApp's enqueueHistoryWrite: reads the (patched) instance at
    // call time, falling back to a raw write when the API is unavailable.
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

    const footerOffsets: number[] = [];
    const capture = (): void => {
      const lines = recorder.viewportLines().map((line) => stripAnsi(line));
      const footerIdx = lines.findIndex((line) => line.includes(FOOTER_BOTTOM));
      footerOffsets.push(footerIdx === -1 ? -1 : lines.length - footerIdx);
    };

    // Stream a 3-paragraph response: text grows, then crosses a blank-line
    // boundary (flush), then grows again, etc. The boundary frames are where the
    // bounce used to occur.
    const steps = [
      paragraph(1),
      `${paragraph(1)}\n\n`,
      `${paragraph(1)}\n\n${paragraph(2)}`,
      `${paragraph(1)}\n\n${paragraph(2)}\n\n`,
      `${paragraph(1)}\n\n${paragraph(2)}\n\n${paragraph(3)}`,
    ];

    const mounted = render(<Driver rawText={steps[0]!} enqueueStdout={enqueueStdout} />, {
      stdout,
      columns: COLUMNS,
      rows: ROWS,
      patchConsole: false,
      maxFps: 1000,
    });
    instanceRef.current = mounted as unknown as {
      insertBeforeFrame?: (data: string) => void;
    };
    await tick();
    capture();
    for (let i = 1; i < steps.length; i++) {
      mounted.rerender(<Driver rawText={steps[i]!} enqueueStdout={enqueueStdout} />);
      await tick();
      await tick();
      capture();
    }
    mounted.unmount();

    // The footer (controls block) must stay pinned the same distance from the
    // bottom on every frame — no transient grow/shrink as paragraphs flush.
    for (const offset of footerOffsets) {
      expect(offset).toBe(footerOffsets[0]);
    }
  });
});
