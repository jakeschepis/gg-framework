import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render } from "ink";
import { Writable } from "node:stream";
import chalk from "chalk";
import { UserMessage } from "./UserMessage.js";
import { ThemeContext, loadTheme, type ThemeName } from "../theme/theme.js";
import type { PromptSegment } from "../../utils/prompt-enhancer.js";

const ENHANCEMENTS: PromptSegment[] = [
  { kind: "text", text: "Add " },
  { kind: "term", text: "debounce", original: "wait a bit" },
  { kind: "text", text: " to the search box." },
];
const ENHANCED = ENHANCEMENTS.map((segment) => segment.text).join("");

function renderRaw(themeName: ThemeName, element: React.ReactElement): string {
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

  render(<ThemeContext.Provider value={loadTheme(themeName)}>{element}</ThemeContext.Provider>, {
    stdout,
    patchConsole: false,
  }).unmount();
  return output;
}

function renderUserMessage(element: React.ReactElement): string {
  return renderRaw("dark", element).replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
    "",
  );
}

describe("UserMessage", () => {
  it("collapses submitted multiline prompts into one displayed user row", () => {
    const output = renderUserMessage(<UserMessage text={"first\nsecond\n\nthird"} />);

    expect(output).toContain("> first ⏎ second ⏎ third");
    expect(output).not.toContain("\nsecond");
  });

  it("teaches the corrected term under an unedited enhanced message", () => {
    const output = renderUserMessage(<UserMessage text={ENHANCED} enhancements={ENHANCEMENTS} />);

    // The term stays glued to its neighbours — no separator space leaks in.
    expect(output).toContain("> Add debounce to the search box.");
    expect(output).toContain("↳ debounce — you said “wait a bit”");
  });

  it("drops the highlight and the footnote when the draft was edited after enhancing", () => {
    const edited = "Add debouncing to the search box.";
    const output = renderUserMessage(<UserMessage text={edited} enhancements={ENHANCEMENTS} />);

    expect(output).toContain(`> ${edited}`);
    expect(output).not.toContain("↳");
    expect(output).not.toContain("you said");
  });

  it("renders a Gemini-style full-width half-line padded message box", () => {
    const output = renderUserMessage(<UserMessage text="hello" />);

    expect(output).toContain("▄".repeat(100));
    expect(output).toContain("> hello");
    expect(output).toContain("▀".repeat(100));
  });
});

/**
 * This row paints its own dark surface in every theme. It used to draw text
 * from the page palette, so darkening the light palette to read on white made
 * the prompt text dark-on-dark and it vanished into its own box.
 */
describe("UserMessage box colours", () => {
  let previousChalkLevel: typeof chalk.level;

  beforeAll(() => {
    // Vitest runs with chalk.level 0, which strips colour and would make these
    // assertions pass vacuously.
    previousChalkLevel = chalk.level;
    chalk.level = 3;
  });

  afterAll(() => {
    chalk.level = previousChalkLevel;
  });

  /** Truecolor SGR foreground sequence for a hex colour. */
  function fg(hex: string): string {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `38;2;${r};${g};${b}`;
  }

  it("emits colour at all", () => {
    // Canary: without this the assertions below could pass on empty output.
    expect(renderRaw("dark", <UserMessage text="hello" />)).toContain("38;2;");
  });

  it.each<ThemeName>(["light", "light-daltonized", "dark", "dark-daltonized"])(
    "%s draws the prompt with the surface token, not the page palette",
    (name) => {
      const theme = loadTheme(name);
      const output = renderRaw(name, <UserMessage text="morning" />);

      expect(output).toContain(fg(theme.inputSurfaceText));
    },
  );

  it("does not paint light-mode page text onto the dark box", () => {
    const light = loadTheme("light");
    const output = renderRaw("light", <UserMessage text="morning" />);

    // commandColor (#4f46e5) sat at 1.64:1 on the #374151 surface — invisible.
    expect(output).not.toContain(fg(light.commandColor));
  });

  it("highlights an enhanced term with the surface accent, bold and underlined", () => {
    const dark = loadTheme("dark");
    const output = renderRaw("dark", <UserMessage text={ENHANCED} enhancements={ENHANCEMENTS} />);

    // \u001b[1m = bold, \u001b[4m = underline — the highlight itself, since
    // `inputSurfaceAccent` equals `inputSurfaceText` in the dark palette.
    expect(output).toContain("\u001b[4m\u001b[1mdebounce");
    expect(output).toContain(fg(dark.inputSurfaceAccent));
  });

  it("uses the surface accent for media labels", () => {
    const light = loadTheme("light");
    const output = renderRaw("light", <UserMessage text="look" imageCount={1} />);

    expect(output).toContain(fg(light.inputSurfaceAccent));
    expect(output).not.toContain(fg(light.accent));
  });
});
