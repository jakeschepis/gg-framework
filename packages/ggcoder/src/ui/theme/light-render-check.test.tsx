import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render } from "ink";
import { Writable } from "node:stream";
import chalk from "chalk";
import { ToolExecution } from "../components/ToolExecution.js";
import { TerminalSizeProvider } from "../hooks/useTerminalSize.js";
import { ThemeContext, loadTheme, type ThemeName } from "./theme.js";
import darkTheme from "./dark.json" with { type: "json" };
import lightTheme from "./light.json" with { type: "json" };

/**
 * End-to-end guard: renders real tool output through the light theme and
 * asserts no dark-theme colour reaches the terminal. Catches components that
 * bypass the theme with hardcoded hex values — ToolExecution shipped 41 of
 * them, so light mode stayed broken no matter what the palette said.
 *
 * Two traps this test is built to avoid:
 *  - Vitest runs with chalk.level 0, which strips every colour and would make
 *    the assertions pass vacuously. The level is forced to truecolor below,
 *    and a canary test proves colour actually reaches the output.
 *  - grep/find/ls are COMPACT_TOOLS: on success they render a one-line summary
 *    and never reach their line renderers, so the cases below use tools that
 *    actually emit a body.
 */

let previousChalkLevel: typeof chalk.level;

beforeAll(() => {
  previousChalkLevel = chalk.level;
  chalk.level = 3;
});

afterAll(() => {
  // chalk.level is process-global — restore it so sibling suites that assert on
  // uncoloured output are unaffected when they share a worker.
  chalk.level = previousChalkLevel;
});

/** Truecolor SGR foreground sequence for a hex colour. */
function fg(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `38;2;${r};${g};${b}`;
}

function paletteOf(theme: Record<string, unknown>): string[] {
  return Object.values(theme).filter(
    (v): v is string => typeof v === "string" && v.startsWith("#"),
  );
}

/**
 * Colours present in the dark palette but absent from the light one. Greys like
 * #6b7280 are shared by both themes, so they are useless as leak markers.
 */
const DARK_ONLY = (() => {
  const light = new Set(paletteOf(lightTheme));
  return [...new Set(paletteOf(darkTheme))].filter((hex) => !light.has(hex));
})();

function renderWithTheme(themeName: ThemeName, element: React.ReactElement): string {
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as NodeJS.WriteStream;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.isTTY = true;
  stdout.getColorDepth = () => 24;

  render(
    <ThemeContext.Provider value={loadTheme(themeName)}>
      <TerminalSizeProvider>{element}</TerminalSizeProvider>
    </ThemeContext.Provider>,
    { stdout, patchConsole: false },
  ).unmount();
  return output;
}

/** Tools that render a real body (not a compact one-line summary). */
const CASES: Array<[string, React.ReactElement]> = [
  [
    "bash (exit 0)",
    <ToolExecution
      name="bash"
      args={{ command: "pnpm build" }}
      result={"Exit code: 0\nAdded 12 lines, removed 3 lines\nBuild success"}
      isError={false}
      status="done"
    />,
  ],
  [
    // Non-zero exit takes a different colour branch (warning, not muted).
    "bash (non-zero exit)",
    <ToolExecution
      name="bash"
      args={{ command: "pnpm test" }}
      result={"Exit code: 1\n2 tests failed\nsee output above"}
      isError={false}
      status="done"
    />,
  ],
  [
    "edit diff",
    <ToolExecution
      name="edit"
      args={{ file_path: "a.ts" }}
      result="--- a\n+++ b"
      details={{ diff: "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old line\n+new line" }}
      isError={false}
      status="done"
    />,
  ],
  [
    "tasks",
    <ToolExecution
      name="tasks"
      args={{}}
      result="[x] rebuild palette t1"
      isError={false}
      status="done"
    />,
  ],
];

describe("light theme end-to-end render", () => {
  it("emits colour at all, and the dark theme really uses dark-only colours", () => {
    // Canary: without this the whole suite could pass while rendering nothing.
    const output = renderWithTheme("dark", CASES[0]![1]);
    const found = DARK_ONLY.filter((hex) => output.includes(fg(hex)));
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(CASES)("%s emits no dark-theme colours under the light theme", (label, element) => {
    const output = renderWithTheme("light", element);
    for (const hex of DARK_ONLY) {
      expect(output, `${label} leaked ${hex}`).not.toContain(fg(hex));
    }
  });

  it("renders light-palette colours instead", () => {
    const output = renderWithTheme("light", CASES[0]![1]);
    expect(output).toContain(fg(lightTheme.success));
  });

  it("error output uses the light error colour, not the dark pastel", () => {
    const output = renderWithTheme(
      "light",
      <ToolExecution
        name="bash"
        args={{ command: "boom" }}
        result="error: command failed"
        isError
        status="done"
      />,
    );
    expect(output).not.toContain(fg(darkTheme.error));
    expect(output).toContain(fg(lightTheme.error));
  });
});
