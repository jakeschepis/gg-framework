import { describe, expect, it } from "vitest";
import { loadTheme, type Theme, type ThemeName } from "./theme.js";

/**
 * Guards the one thing that made light mode unusable: light themes were built
 * from high-luminance pastels meant for a dark background, so body text sat at
 * ~1.2:1 against a white terminal. These tests pin every colour to a minimum
 * contrast against the background the theme actually renders on.
 */

/** Lightest realistic light-terminal background (Warp "Light" ships #ffffff). */
const LIGHT_BG = "#ffffff";
/** Cream light backgrounds (Solarized Light #fdf6e3) are the worst case. */
const LIGHT_BG_CREAM = "#fdf6e3";
/** Representative dark terminal background. */
const DARK_BG = "#111317";

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Colours that are deliberately low-contrast chrome, not text. */
const DECORATIVE = new Set([
  "border",
  "planBorder",
  "subtle",
  "diffAddedDimmed",
  "diffRemovedDimmed",
  "diffAddedWordDimmed",
  "diffRemovedWordDimmed",
]);

/** Non-colour fields. */
const NON_COLOUR = new Set(["name", "background"]);

/**
 * Tokens for the input / user-message box. That box paints its own dark
 * surface in every theme, so these are measured against `inputSurface`
 * instead of the page background — on white they are deliberately light.
 */
const SURFACE_TOKENS = [
  "inputSurfaceText",
  "inputSurfaceDim",
  "inputSurfaceAccent",
  "inputSurfaceError",
] as const;
const SURFACE_KEYS = new Set<string>([...SURFACE_TOKENS, "inputSurface"]);

function colourEntries(theme: Theme): Array<[string, string]> {
  return Object.entries(theme).filter(
    ([key, value]) =>
      !NON_COLOUR.has(key) &&
      !SURFACE_KEYS.has(key) &&
      typeof value === "string" &&
      value.startsWith("#"),
  ) as Array<[string, string]>;
}

const LIGHT_THEMES: ThemeName[] = ["light", "light-daltonized"];
const DARK_THEMES: ThemeName[] = ["dark", "dark-daltonized"];
const ALL_THEMES: ThemeName[] = [
  "dark",
  "light",
  "dark-ansi",
  "light-ansi",
  "dark-daltonized",
  "light-daltonized",
];

describe.each(LIGHT_THEMES)("%s theme on a light background", (name) => {
  const theme = loadTheme(name);

  it.each(colourEntries(theme))("%s (%s) stays legible on white", (key, value) => {
    const minimum = DECORATIVE.has(key) ? 1.4 : 4.5;
    expect(contrastRatio(value, LIGHT_BG)).toBeGreaterThanOrEqual(minimum);
  });

  it("keeps body text readable on cream backgrounds too", () => {
    expect(contrastRatio(theme.text, LIGHT_BG_CREAM)).toBeGreaterThanOrEqual(7);
  });

  it("is actually darker than the background it renders on", () => {
    const bg = relativeLuminance(LIGHT_BG);
    for (const [key, value] of colourEntries(theme)) {
      expect(
        relativeLuminance(value),
        `${key} (${value}) is lighter than the background`,
      ).toBeLessThan(bg);
    }
  });
});

describe.each(DARK_THEMES)("%s theme on a dark background", (name) => {
  const theme = loadTheme(name);

  it.each(colourEntries(theme))("%s (%s) stays legible on #111317", (key, value) => {
    const minimum = DECORATIVE.has(key) ? 1.4 : 3;
    expect(contrastRatio(value, DARK_BG)).toBeGreaterThanOrEqual(minimum);
  });
});

/**
 * The input row and user-message row paint a dark surface in EVERY theme. When
 * the light palette was darkened to read on white, these inherited it and went
 * dark-on-dark — the prompt text vanished into its own box.
 */
describe.each(ALL_THEMES)("%s input surface", (name) => {
  const theme = loadTheme(name);

  it.each(SURFACE_TOKENS)("%s is legible on the surface it renders on", (key) => {
    const value = theme[key];
    expect(contrastRatio(value, theme.inputSurface)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the surface dark so light-on-dark text is correct", () => {
    expect(relativeLuminance(theme.inputSurface)).toBeLessThan(0.2);
  });
});

describe("ANSI variants", () => {
  it("light-ansi uses the normal (dark) ANSI palette, not the bright one", () => {
    const theme = loadTheme("light-ansi");
    // The bright ANSI ramp is washed out on white. Bright black (#555555) is
    // fine — it is the only member dark enough to read.
    const unreadableBrights = new Set([
      "#ff5555",
      "#55ff55",
      "#ffff55",
      "#5555ff",
      "#ff55ff",
      "#55ffff",
      "#ffffff",
    ]);
    for (const [key, value] of colourEntries(theme)) {
      expect(
        unreadableBrights.has(value.toLowerCase()),
        `${key} (${value}) is a bright ANSI colour`,
      ).toBe(false);
    }
    expect(theme.text).toBe("#000000");
  });

  it("dark-ansi keeps a light foreground", () => {
    expect(loadTheme("dark-ansi").text).toBe("#ffffff");
  });
});
