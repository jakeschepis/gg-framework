// Regression for the mid-screen footer "strand" in scrollback mode.
//
// If any single frame reaches terminal height (the app's estimate-based
// live-area clamp can undercount — emoji widths, wrapped footer lines,
// transient tool-panel rows), Ink records lastOutputHeight >= rows. On the
// next SHORTER frame, log-update's eraseLines clamps at the screen top and
// rewrites the frame top-anchored: the footer lands mid-screen with blank
// rows below it and stays there. The patched ink's clipFrameToTerminalHeight
// option (set by ggcoder's scrollback-mode INK_OPTIONS) clips frames to
// rows - 2 so that poisoned state can never be entered. This test renders a
// frame that overflows the terminal, then shrinks it, and asserts the footer
// ends at the bottom of the written content — not stranded above blank rows.
import React from "react";
import { render, Text, Box } from "ink";
import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import { ScreenRecorder, makeRecordingStdout } from "./testing/screen-recorder.js";

const COLUMNS = 80;
const ROWS = 24;
const FOOTER = "SIM_FOOTER_BOTTOM";

function Frame({ bodyRows }: { bodyRows: number }) {
  return (
    <Box flexDirection="column" width={COLUMNS}>
      {Array.from({ length: bodyRows }, (_, i) => (
        <Text key={i}>{`BODY_${String(i + 1).padStart(2, "0")}`}</Text>
      ))}
      <Text>SIM_INPUT</Text>
      <Text>{FOOTER}</Text>
    </Box>
  );
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
}

describe("scrollback frame clip (clipFrameToTerminalHeight)", () => {
  it("clips overflow frames and never strands the footer above blank rows", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(recorder);

    // Overflow: 30 body rows + 2 control rows > 24 terminal rows.
    const mounted = render(<Frame bodyRows={30} />, {
      stdout,
      columns: COLUMNS,
      rows: ROWS,
      patchConsole: false,
      maxFps: 1000,
      // Mirrors ggcoder's scrollback-mode INK_OPTIONS.
      clipFrameToTerminalHeight: true,
    } as Parameters<typeof render>[1]);
    await tick();

    // The clip must keep the frame under terminal height: with rows - 2 = 22
    // frame rows, the oldest body rows are dropped (BODY_01..BODY_10 clipped,
    // mirroring the app's bottom-anchored live-area clamp).
    const tallLines = recorder.viewportLines().map((line) => stripAnsi(line));
    expect(tallLines.some((line) => line.includes("BODY_01"))).toBe(false);
    expect(tallLines.some((line) => line.includes("BODY_30"))).toBe(true);
    expect(tallLines.some((line) => line.includes(FOOTER))).toBe(true);

    // Shrink: the turn ends and the frame collapses to controls + done row.
    // Without the clip this is the poisoned transition (eraseLines clamps at
    // the screen top, frame rewrites top-anchored, footer stranded mid-screen
    // above a block of blank rows).
    mounted.rerender(<Frame bodyRows={3} />);
    await tick();
    mounted.unmount();

    const lines = recorder.viewportLines().map((line) => stripAnsi(line));
    const footerIdx = lines.findIndex((line) => line.includes(FOOTER));
    const lastNonBlank = lines.reduce((acc, line, i) => (line.trim().length > 0 ? i : acc), -1);
    expect(footerIdx, "footer present after shrink").toBeGreaterThanOrEqual(0);
    expect(lastNonBlank, "no blank rows below the footer (no strand)").toBe(footerIdx);
  });
});

describe("scrollback bottom anchoring (anchorFrameToBottom)", () => {
  it("keeps the footer's absolute row fixed when the frame shrinks", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(recorder);

    // A frame that fits comfortably (12 body + 2 control rows).
    const mounted = render(<Frame bodyRows={12} />, {
      stdout,
      columns: COLUMNS,
      rows: ROWS,
      patchConsole: false,
      maxFps: 1000,
      // Mirrors ggcoder's scrollback-mode INK_OPTIONS.
      clipFrameToTerminalHeight: true,
      anchorFrameToBottom: true,
    } as Parameters<typeof render>[1]);
    await tick();

    const footerRowAt = (): number =>
      stripAnsi(recorder.fullText())
        .split("\n")
        .findIndex((line) => line.includes(FOOTER));
    const tallFooterRow = footerRowAt();
    expect(tallFooterRow, "footer present while tall").toBeGreaterThanOrEqual(0);

    // The frame shrinks by 9 rows with no compensating scrollback bytes — the
    // tool-panel-hide / status-swap / finalize scenario. Without anchoring,
    // the footer would move UP by 9 rows; with it, blank pad lines land above
    // the frame and the footer's absolute row stays exactly where it was.
    mounted.rerender(<Frame bodyRows={3} />);
    await tick();
    expect(footerRowAt(), "footer row unchanged after shrink").toBe(tallFooterRow);

    // Growing again must CONSUME the pad debt: the growth overwrites the
    // blank pad rows above the frame (cursor-up) instead of scrolling new
    // rows, so the footer stays exactly put — not pushed further down — and
    // the gap doesn't survive as permanent whitespace in the transcript.
    mounted.rerender(<Frame bodyRows={8} />);
    await tick();
    expect(footerRowAt(), "footer row unchanged on regrow (pad consumed)").toBe(tallFooterRow);

    // No stranded blank gap: between the first body row and the footer, every
    // row is real content (the regrown frame reclaimed the pad rows).
    const lines = stripAnsi(recorder.fullText()).split("\n");
    const firstBody = lines.findIndex((line) => line.includes("BODY_01"));
    const footerIdx = lines.findIndex((line) => line.includes(FOOTER));
    const blanksInside = lines
      .slice(firstBody, footerIdx)
      .filter((line) => line.trim().length === 0).length;
    expect(blanksInside, "no permanent blank gap inside the frame region").toBe(0);

    mounted.unmount();
  });

  it("lets the footer return up at idle (anchor inactive — slash menu close)", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(recorder);

    const mounted = render(<Frame bodyRows={4} />, {
      stdout,
      columns: COLUMNS,
      rows: ROWS,
      patchConsole: false,
      maxFps: 1000,
      clipFrameToTerminalHeight: true,
      anchorFrameToBottom: true,
    } as Parameters<typeof render>[1]);
    const patched = mounted as unknown as { setFrameAnchorActive?: (a: boolean) => void };
    expect(typeof patched.setFrameAnchorActive, "runtime toggle exposed").toBe("function");
    // Idle: App turns pad creation off (agent not running).
    patched.setFrameAnchorActive!(false);
    await tick();

    const footerRowAt = (): number =>
      stripAnsi(recorder.fullText())
        .split("\n")
        .findIndex((line) => line.includes(FOOTER));
    const baseFooterRow = footerRowAt();

    // Slash menu opens: frame grows by 8 rows — footer moves down.
    mounted.rerender(<Frame bodyRows={12} />);
    await tick();
    const openFooterRow = footerRowAt();
    expect(openFooterRow, "footer moved down while menu open").toBeGreaterThan(baseFooterRow);

    // Slash menu closes: with the anchor INACTIVE the shrink is symmetric —
    // the footer returns to its pre-menu row and NO pad rows are created.
    mounted.rerender(<Frame bodyRows={4} />);
    await tick();
    expect(footerRowAt(), "footer returned up after menu close").toBe(baseFooterRow);

    // No whitespace was injected above the frame: the row above BODY_01 in
    // the buffer is not a blank pad line.
    const lines = stripAnsi(recorder.fullText()).split("\n");
    const firstBody = lines.findIndex((line) => line.includes("BODY_01"));
    const blanksInside = lines
      .slice(firstBody, footerRowAt())
      .filter((line) => line.trim().length === 0).length;
    expect(blanksInside, "no pad rows created at idle").toBe(0);

    mounted.unmount();
  });

  it("backfills a bottom-pinned idle shrink with the transcript tail", async () => {
    const recorder = new ScreenRecorder({ columns: COLUMNS, rows: ROWS });
    const stdout = makeRecordingStdout(recorder);

    const mounted = render(<Frame bodyRows={4} />, {
      stdout,
      columns: COLUMNS,
      rows: ROWS,
      patchConsole: false,
      maxFps: 1000,
      clipFrameToTerminalHeight: true,
      anchorFrameToBottom: true,
    } as Parameters<typeof render>[1]);
    const patched = mounted as unknown as {
      insertBeforeFrame?: (d: string) => void;
      setFrameAnchorActive?: (a: boolean) => void;
      setFrameShrinkBackfill?: (fn: (rows: number) => string | undefined) => void;
    };
    patched.setFrameAnchorActive!(false);
    patched.setFrameShrinkBackfill!((rows) =>
      Array.from({ length: rows }, (_, i) => `BACKFILL_${String(i + 1).padStart(2, "0")}`).join(
        "\n",
      ),
    );
    await tick();

    // Fill the screen above the frame with transcript so the frame bottom is
    // pinned at the screen bottom — the chat-in-progress shape.
    patched.insertBeforeFrame!(
      Array.from({ length: ROWS }, (_, i) => `HIST_${String(i + 1).padStart(2, "0")}`).join("\n") +
        "\n",
    );
    // The insert's forced-render fallback fires after 100ms — wait it out so
    // the pinned state is committed before the menu opens.
    await tick();
    await tick();
    await tick();

    const footerRowAt = (): number =>
      stripAnsi(recorder.fullText())
        .split("\n")
        .findIndex((line) => line.includes(FOOTER));
    const pinnedFooterRow = footerRowAt();

    // Slash menu opens: bottom-pinned idle growth must NOT scroll the
    // terminal — ink repaints the screen in place (cursor home + erase-down +
    // shorter tail + taller frame). A scroll pushes a screenful into native
    // scrollback, and every open/close cycle would deposit one more duplicate
    // copy of those rows (the repeated half-banners). In-place repaint
    // appends NOTHING to the recorder's cumulative buffer — a scroll would
    // grow it by the frame-height delta.
    void pinnedFooterRow;
    const bufferLenBeforeOpen = stripAnsi(recorder.fullText()).split("\n").length;
    mounted.rerender(<Frame bodyRows={12} />);
    await tick();
    const openLines = stripAnsi(recorder.fullText()).split("\n");
    expect(openLines.length, "menu open repainted in place (no scroll)").toBe(bufferLenBeforeOpen);
    expect(
      openLines.some((line) => line.includes("BACKFILL_")),
      "tail visible above the open menu",
    ).toBe(true);

    // Slash menu closes: same in-place repaint — taller tail + shorter frame.
    mounted.rerender(<Frame bodyRows={4} />);
    await tick();
    expect(
      stripAnsi(recorder.fullText()).split("\n").length,
      "menu close repainted in place (no scroll)",
    ).toBe(bufferLenBeforeOpen);

    // Inspect the visible screen (bottom ROWS of the buffer): footer at the
    // bottom, tail above the frame, no blanks, no duplicated rows.
    const screen = recorder.viewportLines().map((line) => stripAnsi(line));
    const screenFooterIdx = screen.findIndex((line) => line.includes(FOOTER));
    expect(screenFooterIdx, "footer present after repaint").toBeGreaterThanOrEqual(0);
    const lastNonBlank = screen.reduce((acc, line, i) => (line.trim().length > 0 ? i : acc), -1);
    expect(lastNonBlank, "footer is the last content row").toBe(screenFooterIdx);
    // Everything above the frame is transcript tail — each row appears
    // exactly once (no duplicated banner/prompt rows) and none are blank.
    const frameTop = screenFooterIdx - 6; // 4 body + 2 control rows
    const aboveFrame = screen.slice(0, frameTop);
    expect(
      aboveFrame.every((line) => line.includes("BACKFILL_")),
      "all rows above the frame are backfill transcript",
    ).toBe(true);
    const uniqueRows = new Set(aboveFrame);
    expect(uniqueRows.size, "no duplicated rows above the frame").toBe(aboveFrame.length);

    mounted.unmount();
  });
});
