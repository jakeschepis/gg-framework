import { execFileSync } from "node:child_process";
import chalk from "chalk";
import type { ThemeName } from "./theme.js";

/**
 * Detect the best theme for the current terminal.
 *
 * Detection chain for base theme (first match wins):
 * 1. FORCE_THEME env var (explicit override with any ThemeName)
 * 2. VSCODE_THEME_KIND env var (VS Code integrated terminal)
 * 3. OSC 11 escape sequence query (most modern terminals, incl. Warp)
 * 4. COLORFGBG env var (rxvt, some other terminals)
 * 5. macOS system appearance (defaults read -g AppleInterfaceStyle)
 * 6. Default to "dark"
 *
 * Ordering note: the only thing that actually governs legibility is the
 * *terminal's* background colour, so OSC 11 is asked before the OS-level
 * appearance. macOS appearance is a last-resort guess — a user can (and often
 * does) run a dark terminal profile under a light system theme, or vice versa,
 * and trusting the OS there paints a light palette onto a dark background.
 *
 * Every path falls through to the ANSI-variant selection below; none may
 * return early, or 16-colour terminals silently get truecolor hex codes.
 */
export async function detectTheme(): Promise<ThemeName> {
  // 0. Explicit override — may name an exact variant, so return as-is
  const forceTheme = process.env["FORCE_THEME"];
  if (forceTheme && isValidThemeName(forceTheme)) {
    return forceTheme;
  }

  let base: "dark" | "light" | null = null;

  // 1. VS Code sets this reliably for its integrated terminal
  const vscodeTheme = process.env["VSCODE_THEME_KIND"];
  if (vscodeTheme) {
    base = vscodeTheme.includes("light") ? "light" : "dark";
  }

  // 2. OSC 11 — ask the terminal for its actual background colour
  if (base === null) {
    base = await queryOSC11();
  }

  // 3. COLORFGBG — "fg;bg" ANSI color indices
  if (base === null) {
    const colorfgbg = process.env["COLORFGBG"];
    if (colorfgbg) {
      const bg = parseInt(colorfgbg.split(";").at(-1)!, 10);
      if (!isNaN(bg)) {
        base = bg === 7 || (bg >= 9 && bg <= 15) ? "light" : "dark";
      }
    }
  }

  // 4. macOS system appearance — heuristic fallback for terminals that
  //    answer neither OSC 11 nor COLORFGBG (e.g. Apple Terminal).
  if (base === null && process.platform === "darwin") {
    base = macOSAppearance();
  }

  // 5. Default
  if (base === null) base = "dark";

  // Auto-select ANSI variant for terminals without truecolor support
  if (chalk.level < 3) {
    return `${base}-ansi` as ThemeName;
  }

  return base;
}

/**
 * Read the macOS system appearance. `AppleInterfaceStyle` is only present when
 * dark mode is on, so a failed read means light mode.
 */
function macOSAppearance(): "dark" | "light" {
  try {
    const result = execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
      encoding: "utf-8",
      timeout: 500,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim().toLowerCase() === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const VALID_THEMES = new Set<string>([
  "dark",
  "light",
  "dark-ansi",
  "light-ansi",
  "dark-daltonized",
  "light-daltonized",
]);

function isValidThemeName(name: string): name is ThemeName {
  return VALID_THEMES.has(name);
}

/**
 * Send OSC 11 query to the terminal and parse the background color response.
 * Returns "dark" | "light" based on luminance, or null if unsupported.
 *
 * Note: does NOT send the ESC[6n cursor position sentinel — that response
 * (ESC[row;colR) can leak into stdin if not drained before Ink takes over,
 * causing "[2;1R" to appear in the chat input. Instead we rely on a simple
 * timeout to detect unsupported terminals.
 */
// ESC character built without a literal escape so ESLint's no-control-regex is satisfied
const ESC = String.fromCharCode(27);
const oscResponsePattern = new RegExp(
  ESC + "\\]11;rgb:([0-9a-fA-F]+)/([0-9a-fA-F]+)/([0-9a-fA-F]+)",
);

function queryOSC11(): Promise<"dark" | "light" | null> {
  return new Promise((resolve) => {
    // Skip for multiplexers — they don't forward OSC queries
    const term = process.env["TERM"] ?? "";
    if (term.startsWith("screen") || term.startsWith("tmux")) {
      resolve(null);
      return;
    }

    // Need a real TTY
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(null);
      return;
    }

    const wasRaw = process.stdin.isRaw;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("data", onData);
      try {
        process.stdin.setRawMode(wasRaw);
      } catch {
        // ignore
      }
      if (!wasRaw) {
        try {
          process.stdin.pause();
        } catch {
          // ignore
        }
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 200);

    const onData = (data: Buffer) => {
      const str = data.toString();

      // Look for OSC 11 response: ESC]11;rgb:RRRR/GGGG/BBBB followed by BEL or ST
      const match = str.match(oscResponsePattern);
      if (match) {
        clearTimeout(timeout);
        cleanup();

        // Parse RGB values (can be 1, 2, or 4 hex digits per channel)
        const r = normalizeChannel(match[1]!);
        const g = normalizeChannel(match[2]!);
        const b = normalizeChannel(match[3]!);

        // Relative luminance (ITU-R BT.709)
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        resolve(luminance < 0.5 ? "dark" : "light");
      }
    };

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);

      // Send only the OSC 11 query — no ESC[6n sentinel to avoid
      // cursor position responses leaking into Ink's input
      process.stdout.write("\x1b]11;?\x1b\\");
    } catch {
      clearTimeout(timeout);
      cleanup();
      resolve(null);
    }
  });
}

/** Normalize a hex color channel (1-4 hex digits) to 0.0–1.0 range. */
function normalizeChannel(hex: string): number {
  const value = parseInt(hex, 16);
  switch (hex.length) {
    case 1:
      return value / 0xf;
    case 2:
      return value / 0xff;
    case 4:
      return value / 0xffff;
    default:
      return value / (Math.pow(16, hex.length) - 1);
  }
}
