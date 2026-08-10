import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { Writable } from "node:stream";
import { InputArea, type PasteInfo } from "./InputArea.js";
import { SPINNER_FRAMES } from "../spinner-frames.js";
import { ThemeContext, loadTheme } from "../theme/theme.js";

const inputHandlers: Array<(input: string, key: Record<string, boolean>) => void> = [];

vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<{ render: typeof render }>();
  return {
    ...actual,
    useInput: (handler: (input: string, key: Record<string, boolean>) => void) => {
      inputHandlers.push(handler);
    },
    useStdin: () => ({ internal_eventEmitter: { emit: vi.fn() } }),
  };
});

vi.mock("../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 100, rows: 30 }),
}));

vi.mock("./AnimationContext.js", () => ({
  deriveFrame: () => 0,
  useFocusedAnimation: () => ({ active: false, tick: 0 }),
}));

vi.mock("../../utils/image.js", () => {
  const extractImagePaths = async () => ({ imagePaths: [], cleanText: "" });
  const readImageFile = async () => ({ kind: "text", fileName: "unused", content: "" });
  return {
    extractImagePaths,
    extractMediaPaths: extractImagePaths,
    getClipboardImage: async () => null,
    readImageFile,
    readMediaFile: readImageFile,
  };
});

// Instances from earlier tests keep re-rendering and pushing onto the shared
// `inputHandlers` array, so `at(-1)` could belong to another test's component.
// Unmount the previous one before each render to keep the handler unambiguous.
let mounted: { unmount: () => void } | null = null;

function renderInputArea(onSubmit = vi.fn(), extraProps: Record<string, unknown> = {}) {
  mounted?.unmount();
  inputHandlers.length = 0;
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
  const theme = loadTheme("dark");
  const result = render(
    <ThemeContext.Provider value={theme}>
      <InputArea
        onSubmit={onSubmit}
        onAbort={vi.fn()}
        cwd={process.cwd()}
        disableMouseTracking
        {...extraProps}
      />
    </ThemeContext.Provider>,
    { stdout, patchConsole: false },
  );
  mounted = result;
  return { ...result, theme, output: () => output };
}

function enterText(text: string) {
  inputHandlers.at(-1)?.(text, {});
}

/** Yield so Ink commits a render and re-registers the input handler with fresh
 *  closure state — a real terminal delivers keystrokes in separate ticks too. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function pressEnter() {
  inputHandlers.at(-1)?.("", { return: true });
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

describe("InputArea pasted slash commands", () => {
  it("keeps the slash command prefix styled while a pasted placeholder is displayed and submits the original paste", async () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    const { rerender, theme, output } = renderInputArea(onSubmit);

    const prefix = "/help explain ";
    const pasted = "first line\nsecond line\nthird line";
    const fullInput = prefix + pasted;

    for (const char of prefix) enterText(char);
    enterText(pasted);
    await vi.runOnlyPendingTimersAsync();
    rerender(
      <ThemeContext.Provider value={theme}>
        <InputArea onSubmit={onSubmit} onAbort={vi.fn()} cwd={process.cwd()} disableMouseTracking />
      </ThemeContext.Provider>,
    );

    await vi.waitFor(() => {
      expect(output()).toContain("/help explain [Pasted text #33 +3 lines]");
    });
    // ANSI escapes are disabled for this captured Ink stream, but this assertion
    // fails on the original regression where the placeholder dropped the prefix.
    expect(stripAnsi(output())).toContain(" > /help explain [Pasted text #33 +3 lines]");

    pressEnter();

    const expectedPaste: PasteInfo = { offset: prefix.length, length: pasted.length, lineCount: 3 };
    expect(onSubmit).toHaveBeenCalledWith(fullInput, [], expectedPaste);
    vi.useRealTimers();
  });

  it("paints the Gemini-style input background across the full input height", () => {
    const { output } = renderInputArea();

    const plain = stripAnsi(output());
    expect(plain).toContain("▄".repeat(100));
    expect(plain).toContain("▀".repeat(100));
    expect(plain).toContain(" >   Type your message or / to run a command");
  });
});

describe("InputArea Ctrl+A", () => {
  it("toggles autopilot instead of jumping to line start", () => {
    const onToggleAutopilot = vi.fn();
    renderInputArea(vi.fn(), { onToggleAutopilot });

    enterText("hello");
    inputHandlers.at(-1)?.("a", { ctrl: true });

    expect(onToggleAutopilot).toHaveBeenCalledTimes(1);
  });

  it("leaves Ctrl+Shift+A on line-start-extending-selection", () => {
    const onToggleAutopilot = vi.fn();
    renderInputArea(vi.fn(), { onToggleAutopilot });

    enterText("hello");
    inputHandlers.at(-1)?.("a", { ctrl: true, shift: true });

    expect(onToggleAutopilot).not.toHaveBeenCalled();
  });

  it("still reaches line start via the Home key", async () => {
    const { rerender, theme, output } = renderInputArea(vi.fn(), {
      onToggleAutopilot: vi.fn(),
    });

    for (const char of "bc") {
      enterText(char);
      await tick();
    }
    // Ink parses \x1b[H / \x1b[1~ / \x1bOH into key.home and blanks `input`,
    // so this is exactly what the handler receives for a real Home keypress.
    // Matching on the raw escape sequence would never fire.
    inputHandlers.at(-1)?.("", { home: true });
    await tick();
    enterText("a");
    rerender(
      <ThemeContext.Provider value={theme}>
        <InputArea
          onSubmit={vi.fn()}
          onAbort={vi.fn()}
          cwd={process.cwd()}
          disableMouseTracking
          onToggleAutopilot={vi.fn()}
        />
      </ThemeContext.Provider>,
    );

    await vi.waitFor(() => {
      expect(stripAnsi(output())).toContain(" > abc");
    });
  });

  it("reaches line end via the End key", async () => {
    const { rerender, theme, output } = renderInputArea(vi.fn(), {
      onToggleAutopilot: vi.fn(),
    });

    for (const char of "bc") {
      enterText(char);
      await tick();
    }
    inputHandlers.at(-1)?.("", { home: true });
    await tick();
    inputHandlers.at(-1)?.("", { end: true });
    await tick();
    enterText("d");
    rerender(
      <ThemeContext.Provider value={theme}>
        <InputArea
          onSubmit={vi.fn()}
          onAbort={vi.fn()}
          cwd={process.cwd()}
          disableMouseTracking
          onToggleAutopilot={vi.fn()}
        />
      </ThemeContext.Provider>,
    );

    await vi.waitFor(() => {
      expect(stripAnsi(output())).toContain(" > bcd");
    });
  });
});

describe("InputArea Ctrl+E", () => {
  it("hands the draft to the enhancer instead of jumping to line end", async () => {
    const onEnhance = vi.fn();
    renderInputArea(vi.fn(), { onEnhance });

    enterText("make the list load faster");
    await tick();
    inputHandlers.at(-1)?.("e", { ctrl: true });

    expect(onEnhance).toHaveBeenCalledWith("make the list load faster");
  });

  it("does nothing on an empty draft", async () => {
    const onEnhance = vi.fn();
    renderInputArea(vi.fn(), { onEnhance });

    await tick();
    inputHandlers.at(-1)?.("e", { ctrl: true });

    expect(onEnhance).not.toHaveBeenCalled();
  });

  it("does not stack a second call while one is already in flight", async () => {
    const onEnhance = vi.fn();
    renderInputArea(vi.fn(), { onEnhance, enhancing: true });

    enterText("already enhancing");
    await tick();
    inputHandlers.at(-1)?.("e", { ctrl: true });

    expect(onEnhance).not.toHaveBeenCalled();
  });

  it("keeps plain readline end-of-line when no enhance handler is wired", async () => {
    // Without `onEnhance` the guard falls through, so Ctrl+E keeps its readline
    // meaning — this is what print/embedded hosts get.
    const { rerender, theme, output } = renderInputArea(vi.fn());

    for (const char of "bc") {
      enterText(char);
      await tick();
    }
    inputHandlers.at(-1)?.("", { home: true });
    await tick();
    inputHandlers.at(-1)?.("e", { ctrl: true });
    await tick();
    enterText("d");
    rerender(
      <ThemeContext.Provider value={theme}>
        <InputArea onSubmit={vi.fn()} onAbort={vi.fn()} cwd={process.cwd()} disableMouseTracking />
      </ThemeContext.Provider>,
    );

    await vi.waitFor(() => {
      expect(stripAnsi(output())).toContain(" > bcd");
    });
  });

  it("leaves Ctrl+Shift+E on line-end-extending-selection", async () => {
    // The documented escape hatch for readline end-of-line. Only reachable on
    // terminals that report the shift bit (kitty keyboard protocol) — which is
    // what passing `shift: true` here simulates. See the enhancer handler in
    // InputArea.tsx for why Terminal.app can't get here.
    const onEnhance = vi.fn();
    const { rerender, theme, output } = renderInputArea(vi.fn(), { onEnhance });

    for (const char of "bc") {
      enterText(char);
      await tick();
    }
    inputHandlers.at(-1)?.("", { home: true });
    await tick();
    inputHandlers.at(-1)?.("e", { ctrl: true, shift: true });
    await tick();
    // Typing replaces the selection, so "bc" only disappears if Ctrl+Shift+E
    // really anchored at 0 and moved the cursor to the end.
    enterText("z");
    rerender(
      <ThemeContext.Provider value={theme}>
        <InputArea
          onSubmit={vi.fn()}
          onAbort={vi.fn()}
          cwd={process.cwd()}
          disableMouseTracking
          onEnhance={onEnhance}
        />
      </ThemeContext.Provider>,
    );

    await vi.waitFor(() => {
      expect(stripAnsi(output())).toContain(" > z");
    });
    expect(onEnhance).not.toHaveBeenCalled();
    expect(stripAnsi(output())).not.toContain(" > zbc");
  });

  it("leaves Ctrl+E on line-end even for a whitespace-only draft", async () => {
    // The enhancer's guard used to be a dead key on drafts it declined to
    // enhance: whitespace-only text failed the `value.trim()` check but the
    // keystroke was consumed anyway. Ctrl+E must reach end-of-line regardless
    // of what the draft holds, and must never wake the enhancer.
    const onEnhance = vi.fn();
    const { rerender, theme, output } = renderInputArea(vi.fn(), { onEnhance });

    for (const char of "  ") {
      enterText(char);
      await tick();
    }
    inputHandlers.at(-1)?.("", { home: true });
    await tick();
    inputHandlers.at(-1)?.("e", { ctrl: true });
    await tick();
    enterText("d");
    rerender(
      <ThemeContext.Provider value={theme}>
        <InputArea
          onSubmit={vi.fn()}
          onAbort={vi.fn()}
          cwd={process.cwd()}
          disableMouseTracking
          onEnhance={onEnhance}
        />
      </ThemeContext.Provider>,
    );

    // "d" lands after the spaces only if Ctrl+E moved the cursor to the end;
    // a dead key would leave the cursor at 0 and render " > d" instead.
    await vi.waitFor(() => {
      expect(stripAnsi(output())).toContain(" >   d");
    });
    expect(stripAnsi(output())).not.toContain(" > d");
    expect(onEnhance).not.toHaveBeenCalled();
  });

  it("still reaches line end via the End key", async () => {
    const { rerender, theme, output } = renderInputArea(vi.fn(), { onEnhance: vi.fn() });

    for (const char of "bc") {
      enterText(char);
      await tick();
    }
    inputHandlers.at(-1)?.("", { home: true });
    await tick();
    inputHandlers.at(-1)?.("", { end: true });
    await tick();
    enterText("d");
    rerender(
      <ThemeContext.Provider value={theme}>
        <InputArea
          onSubmit={vi.fn()}
          onAbort={vi.fn()}
          cwd={process.cwd()}
          disableMouseTracking
          onEnhance={vi.fn()}
        />
      </ThemeContext.Provider>,
    );

    await vi.waitFor(() => {
      expect(stripAnsi(output())).toContain(" > bcd");
    });
  });
});

describe("InputArea injectText", () => {
  async function typeDraftAndInject(mode?: "append" | "replace") {
    const onSubmit = vi.fn();
    const { rerender, theme } = renderInputArea(onSubmit);

    enterText("rough draft");
    await tick();
    rerender(
      <ThemeContext.Provider value={theme}>
        <InputArea
          onSubmit={onSubmit}
          onAbort={vi.fn()}
          cwd={process.cwd()}
          disableMouseTracking
          injectText={{ text: "enhanced prompt", nonce: 1, ...(mode ? { mode } : {}) }}
        />
      </ThemeContext.Provider>,
    );
    await tick();
    pressEnter();
    return onSubmit;
  }

  it("appends by default, preserving the queued-message behaviour", async () => {
    const onSubmit = await typeDraftAndInject();

    expect(onSubmit).toHaveBeenCalledWith("rough draft\n\nenhanced prompt", [], undefined);
  });

  it("swaps the whole draft in replace mode", async () => {
    const onSubmit = await typeDraftAndInject("replace");

    expect(onSubmit).toHaveBeenCalledWith("enhanced prompt", [], undefined);
  });
});

describe("InputArea enhancing state", () => {
  const draft = "make the list load faster";

  function renderEnhancing(onAbort = vi.fn()) {
    mounted?.unmount();
    inputHandlers.length = 0;
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
    const theme = loadTheme("dark");
    const element = (
      <ThemeContext.Provider value={theme}>
        <InputArea
          onSubmit={vi.fn()}
          onAbort={onAbort}
          cwd={process.cwd()}
          disableMouseTracking
          enhancing
          onEnhance={vi.fn()}
          injectText={{ text: draft, nonce: 1, mode: "replace" }}
        />
      </ThemeContext.Provider>
    );
    const result = render(element, { stdout, patchConsole: false });
    mounted = result;
    return { ...result, flush: () => result.rerender(element), output: () => output };
  }

  it("replaces the > prompt glyph with a spinner frame", async () => {
    const { flush, output } = renderEnhancing();

    await tick();
    flush();

    await vi.waitFor(() => {
      expect(stripAnsi(output())).toContain(`${SPINNER_FRAMES[0]} ${draft}`);
    });
    expect(stripAnsi(output())).not.toContain(`> ${draft}`);
  });

  it("absorbs keystrokes so the frozen draft can't be edited", async () => {
    const { flush, output } = renderEnhancing();

    await tick();
    inputHandlers.at(-1)?.("x", {});
    await tick();
    flush();

    await vi.waitFor(() => {
      expect(stripAnsi(output())).toContain(draft);
    });
    expect(stripAnsi(output())).not.toContain(`${draft}x`);
  });

  it("still lets Esc through so the enhancement can be cancelled", async () => {
    const onAbort = vi.fn();
    renderEnhancing(onAbort);

    await tick();
    inputHandlers.at(-1)?.("", { escape: true });

    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("still lets Ctrl+C through so the enhancement can be cancelled", async () => {
    const onAbort = vi.fn();
    renderEnhancing(onAbort);

    await tick();
    inputHandlers.at(-1)?.("c", { ctrl: true });

    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});
