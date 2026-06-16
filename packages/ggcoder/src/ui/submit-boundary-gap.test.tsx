// Self-test for the "white space before the LLM responds" gap that appears
// when submitting a slash command (e.g. /commit).
//
// The submit boundary stacks several frame SHRINKS into the moment the agent
// is (re)starting, while the patched ink bottom-anchor is ACTIVE:
//   1. the prior turn's live items flush to scrollback + the live frame clears
//      (setLiveItems([])),
//   2. the open slash menu closes (the controls block gets shorter).
// Each shrink-while-active becomes blank "pad debt" above the frame so the
// footer can't jump up. The new turn then enters a quiet thinking phase with
// NO frame growth, so nothing consumes the pads — they sit on screen as a blank
// gap before any LLM output, exactly what the user reported.
//
// This drives the REAL patched ink through that byte sequence and asserts:
//   A) the gap genuinely forms at the submit boundary (the bug), and
//   B) the mid-run off→on reclaim pulse (App's fix) collapses it while keeping
//      the footer bottom-pinned.
import React from "react";
import { Box, render, Text } from "ink";
import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import { ScreenRecorder, makeRecordingStdout } from "./testing/screen-recorder.js";

const COLUMNS = 80;
const ROWS = 24;

const FOOTER = "SIM_FOOTER_BOTTOM";
const FRAME_TOP = "SIM_FRAME_TOP";

// Controls block: the slash menu adds rows ABOVE the input while open, so
// closing it is a real controls-height shrink (same shape as the menu close
// that fires on submit).
function Controls({ liveRows, menuOpen }: { liveRows: number; menuOpen: boolean }) {
  return (
    <Box flexDirection="column" width={COLUMNS}>
      <Text>{FRAME_TOP}</Text>
      {Array.from({ length: liveRows }, (_, i) => (
        <Text key={i}>SIM_LIVE_{i + 1}</Text>
      ))}
      {menuOpen
        ? Array.from({ length: 6 }, (_, i) => <Text key={`m${i}`}>SIM_MENU_ITEM_{i + 1}</Text>)
        : null}
      <Text>SIM_INPUT</Text>
      <Text>{FOOTER}</Text>
    </Box>
  );
}

interface PatchedInstance {
  insertBeforeFrame?: (data: string) => void;
  setFrameAnchorActive?: (active: boolean) => void;
  setFrameShrinkBackfill?: (fn: (needRows: number) => string | undefined) => void;
  rerender: (node: React.ReactElement) => void;
  unmount: () => void;
}

async function tick(ms = 60): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function blanksAboveFrame(recorder: ScreenRecorder): number {
  const lines = recorder.viewportLines().map((line) => stripAnsi(line));
  const frameTopIdx = lines.findIndex((line) => line.includes(FRAME_TOP));
  if (frameTopIdx < 0) return -1;
  return lines.slice(0, frameTopIdx).filter((line) => line.trim() === "").length;
}

describe("submit-boundary gap", () => {
  it("forms the gap at submit then the reclaim pulse collapses it (footer stays pinned)", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(recorder);
    const transcriptRows = Array.from({ length: ROWS }, (_, i) => `SIM_HISTORY_${i + 1}`);

    const mounted = render(<Controls liveRows={2} menuOpen={false} />, {
      stdout,
      patchConsole: false,
      maxFps: 1000,
      anchorFrameToBottom: true,
      clipFrameToTerminalHeight: true,
    } as Parameters<typeof render>[1]) as unknown as PatchedInstance;

    // Skip cleanly on unpatched ink (fork-only APIs).
    if (!mounted.setFrameAnchorActive || !mounted.insertBeforeFrame) {
      mounted.unmount();
      return;
    }
    mounted.setFrameShrinkBackfill?.((needRows: number) => {
      const lines = transcriptRows.slice(-needRows);
      while (lines.length < needRows) lines.unshift("");
      return `${lines.join("\n")}\n`;
    });
    await tick();

    // Prior turn finished streaming a tall response; the slash menu is open
    // because the user typed "/commit". Anchor is ACTIVE (agent considered
    // running through the submit). Flush the scrollback history first.
    mounted.setFrameAnchorActive(true);
    mounted.insertBeforeFrame(`${transcriptRows.join("\n")}\n`);
    mounted.rerender(<Controls liveRows={10} menuOpen={true} />);
    await tick();

    // SUBMIT: prior live rows flush + clear (live shrinks to 1) AND the slash
    // menu closes — two stacked shrinks with NO compensating scrollback insert,
    // while the anchor is active. Pad debt forms.
    mounted.rerender(<Controls liveRows={1} menuOpen={false} />);
    await tick();

    // Quiet thinking phase: nothing grows the frame. The gap is now on screen
    // BEFORE any LLM output — the reported bug.
    const gapAtSubmit = blanksAboveFrame(recorder);
    expect(gapAtSubmit, "gap genuinely forms at the submit boundary").toBeGreaterThan(0);

    // App's mid-run reclaim pulse (fires after the frame is stable): off→on.
    mounted.setFrameAnchorActive(false);
    mounted.setFrameAnchorActive(true);
    await tick(150);

    const lines = recorder.viewportLines().map((line) => stripAnsi(line));
    const frameTopIdx = lines.findIndex((line) => line.includes(FRAME_TOP));
    const footerIdx = lines.findIndex((line) => line.includes(FOOTER));
    expect(frameTopIdx, "live frame visible").toBeGreaterThanOrEqual(0);
    expect(footerIdx, "footer visible").toBeGreaterThan(frameTopIdx);

    // The gap is gone.
    expect(blanksAboveFrame(recorder), "reclaim pulse collapses the submit-boundary gap").toBe(0);

    // Footer still bottom-pinned (nothing below it).
    const lastNonBlank = lines.reduce((acc, line, i) => (line.trim().length > 0 ? i : acc), -1);
    expect(lastNonBlank, "nothing below the footer after reclaim").toBe(footerIdx);

    mounted.unmount();
  });

  it("reclaims a finishing tool-batch collapse mid-run (no menu involved)", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(recorder);
    const transcriptRows = Array.from({ length: ROWS }, (_, i) => `SIM_HISTORY_${i + 1}`);

    const mounted = render(<Controls liveRows={2} menuOpen={false} />, {
      stdout,
      patchConsole: false,
      maxFps: 1000,
      anchorFrameToBottom: true,
      clipFrameToTerminalHeight: true,
    } as Parameters<typeof render>[1]) as unknown as PatchedInstance;

    if (!mounted.setFrameAnchorActive || !mounted.insertBeforeFrame) {
      mounted.unmount();
      return;
    }
    mounted.setFrameShrinkBackfill?.((needRows: number) => {
      const lines = transcriptRows.slice(-needRows);
      while (lines.length < needRows) lines.unshift("");
      return `${lines.join("\n")}\n`;
    });
    await tick();

    // Mid-run: a batch of tool panels expands the live frame, then collapses
    // when the batch finishes — a shrink with no compensating insert. Debt forms.
    mounted.setFrameAnchorActive(true);
    mounted.insertBeforeFrame(`${transcriptRows.join("\n")}\n`);
    mounted.rerender(<Controls liveRows={11} menuOpen={false} />);
    await tick();
    mounted.rerender(<Controls liveRows={2} menuOpen={false} />);
    await tick();
    expect(blanksAboveFrame(recorder), "tool-batch collapse forms a gap").toBeGreaterThan(0);

    // Reclaim pulse collapses it.
    mounted.setFrameAnchorActive(false);
    mounted.setFrameAnchorActive(true);
    await tick(150);
    expect(blanksAboveFrame(recorder), "tool-batch gap reclaimed").toBe(0);

    mounted.unmount();
  });

  it("is a harmless no-op when there is no pad debt (steady streaming)", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(recorder);
    const transcriptRows = Array.from({ length: ROWS }, (_, i) => `SIM_HISTORY_${i + 1}`);

    const mounted = render(<Controls liveRows={2} menuOpen={false} />, {
      stdout,
      patchConsole: false,
      maxFps: 1000,
      anchorFrameToBottom: true,
      clipFrameToTerminalHeight: true,
    } as Parameters<typeof render>[1]) as unknown as PatchedInstance;

    if (!mounted.setFrameAnchorActive || !mounted.insertBeforeFrame) {
      mounted.unmount();
      return;
    }
    mounted.setFrameShrinkBackfill?.((needRows: number) => {
      const lines = transcriptRows.slice(-needRows);
      while (lines.length < needRows) lines.unshift("");
      return `${lines.join("\n")}\n`;
    });
    await tick();

    // Anchor active, frame only GROWS (no shrink) — no debt is ever created.
    mounted.setFrameAnchorActive(true);
    mounted.rerender(<Controls liveRows={4} menuOpen={false} />);
    await tick();
    expect(blanksAboveFrame(recorder), "no gap during pure growth").toBe(0);

    // A reclaim pulse here must change nothing: footer pinned, no gap, frame
    // unchanged — proving the pulse is a safe no-op when debt is zero.
    mounted.setFrameAnchorActive(false);
    mounted.setFrameAnchorActive(true);
    await tick(150);

    const lines = recorder.viewportLines().map((line) => stripAnsi(line));
    const footerIdx = lines.findIndex((line) => line.includes(FOOTER));
    const lastNonBlank = lines.reduce((acc, line, i) => (line.trim().length > 0 ? i : acc), -1);
    expect(blanksAboveFrame(recorder), "still no gap after no-op pulse").toBe(0);
    expect(lastNonBlank, "footer still pinned after no-op pulse").toBe(footerIdx);

    mounted.unmount();
  });
});
