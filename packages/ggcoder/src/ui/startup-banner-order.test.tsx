// Regression: the startup banner must render ABOVE the controls frame.
//
// Ink's legacy sync mode flushes passive effects DURING render(), so the very
// first transcript print (the banner) fires while renderApp's ref.instance is
// still null. Without pre-mount buffering in enqueueHistoryWrite, those bytes
// were raw-written AFTER Ink painted the first frame — stranding the controls
// at the top of the screen with a cut-off banner (and the whole conversation)
// below them. render.ts buffers pre-mount bytes and flushes them through the
// patched insertBeforeFrame right after the instance is assigned; this test
// models that exact closure and asserts the final ordering.
import React, { useRef, useState } from "react";
import { render, Text, useStdout } from "ink";
import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import type { CompletedItem } from "./app-items.js";
import { ChatControls, ChatLayout } from "./components/ChatLayout.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import { loadTheme, ThemeContext } from "./theme/theme.js";
import { createTerminalHistoryPrinter } from "./terminal-history.js";
import type { TerminalHistoryContext } from "./terminal-history.js";
import { useTranscriptHistory } from "./hooks/useTranscriptHistory.js";
import { ScreenRecorder, makeRecordingStdout } from "./testing/screen-recorder.js";

const COLUMNS = 100;
const ROWS = 30;
const theme = loadTheme("dark");
const terminalContext: TerminalHistoryContext = {
  theme,
  columns: COLUMNS,
  version: "9.9.9",
  model: "sim-model",
  provider: "anthropic",
  cwd: "/tmp/sim-project",
};

function Controls() {
  return (
    <ChatControls controlsRef={() => {}}>
      <Text>SIM_STATUS Ready to go..</Text>
      <Text>SIM_INPUT type your message</Text>
      <Text>SIM_FOOTER gg-coder</Text>
    </ChatControls>
  );
}

function Driver({ enqueueStdout }: { enqueueStdout: (d: string) => void }) {
  const { write: writeStdout } = useStdout();
  // Mirrors App: initial history contains the banner.
  const [history, setHistory] = useState<CompletedItem[]>([
    { kind: "banner", id: "banner" } as CompletedItem,
  ]);
  const [liveItems, setLiveItems] = useState<CompletedItem[]>([]);
  const printerRef = useRef<ReturnType<typeof createTerminalHistoryPrinter> | null>(null);
  printerRef.current ??= createTerminalHistoryPrinter();
  useTranscriptHistory({
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
  void liveItems;
  return (
    <ThemeContext.Provider value={theme}>
      <TerminalSizeProvider>
        <ChatLayout columns={COLUMNS}>
          <Controls />
        </ChatLayout>
      </TerminalSizeProvider>
    </ThemeContext.Provider>
  );
}

async function tick(ms = 60): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

describe("startup banner ordering", () => {
  it("renders banner ABOVE the controls frame", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(recorder);
    // Mirrors render.ts enqueueHistoryWrite incl. pre-mount buffering.
    const instanceRef: { current: { insertBeforeFrame?: (d: string) => void } | null } = {
      current: null,
    };
    let preMount = "";
    const enqueueStdout = (data: string): void => {
      if (!instanceRef.current) {
        preMount += data;
        return;
      }
      if (instanceRef.current.insertBeforeFrame) instanceRef.current.insertBeforeFrame(data);
      else stdout.write(data);
    };
    const mounted = render(<Driver enqueueStdout={enqueueStdout} />, {
      stdout,
      columns: COLUMNS,
      rows: ROWS,
      patchConsole: false,
    });
    instanceRef.current = mounted as unknown as { insertBeforeFrame?: (d: string) => void };
    if (preMount) {
      const buffered = preMount;
      preMount = "";
      enqueueStdout(buffered);
    }
    await tick();
    await tick();
    mounted.unmount();
    const full = stripAnsi(recorder.fullText());
    const lines = full.split("\n");
    const bannerRow = lines.findIndex((l) => l.includes("██") || l.includes("GG Coder"));
    const statusRow = lines.findIndex((l) => l.includes("SIM_STATUS"));
    expect(bannerRow, "banner present").toBeGreaterThanOrEqual(0);
    expect(statusRow, "controls present").toBeGreaterThanOrEqual(0);
    expect(bannerRow, "banner above controls").toBeLessThan(statusRow);
  });
});
