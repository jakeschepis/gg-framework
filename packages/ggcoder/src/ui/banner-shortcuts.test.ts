import { describe, expect, it } from "vitest";
import {
  MAX_SHORTCUT_HINT_ROWS,
  SHORTCUT_HINTS,
  fitShortcutHints,
  layoutShortcutHints,
  shortcutHintsWidth,
} from "./banner-shortcuts.js";

describe("banner shortcut hints", () => {
  it("advertises the autopilot toggle", () => {
    expect(SHORTCUT_HINTS.map((h) => h.key)).toContain("Ctrl+A");
    expect(SHORTCUT_HINTS.find((h) => h.key === "Ctrl+A")?.label).toBe("autopilot");
  });

  it("advertises the prompt enhancer", () => {
    expect(SHORTCUT_HINTS.map((h) => h.key)).toContain("Ctrl+E");
    expect(SHORTCUT_HINTS.find((h) => h.key === "Ctrl+E")?.label).toBe("enhance");
  });

  it("keeps every hint when the row fits", () => {
    expect(fitShortcutHints(shortcutHintsWidth(SHORTCUT_HINTS))).toHaveLength(
      SHORTCUT_HINTS.length,
    );
  });

  it("drops from the end rather than overflowing a single row", () => {
    const fits = fitShortcutHints(shortcutHintsWidth(SHORTCUT_HINTS) - 1);

    expect(fits).toHaveLength(SHORTCUT_HINTS.length - 1);
    expect(shortcutHintsWidth(fits)).toBeLessThan(shortcutHintsWidth(SHORTCUT_HINTS));
  });

  it("always keeps at least one hint, however narrow the terminal", () => {
    expect(fitShortcutHints(0)).toEqual([SHORTCUT_HINTS[0]]);
  });

  it("measures display columns, not JS string length", () => {
    // A CJK label occupies two terminal columns per character while JS reports
    // one, so `.length` would under-measure the row and let it overflow.
    const wide = [{ key: "Ctrl+W", label: "宽字符" }];

    expect(shortcutHintsWidth(wide)).toBe("Ctrl+W ".length + 6);
  });
});

describe("banner shortcut hint layout", () => {
  // The stacked banner budget at an 80-column terminal: full width minus the
  // one-column left pad. This is the width the whole two-row design exists for.
  const EIGHTY_COLUMN_BUDGET = 80 - 1;

  it("keeps every hint at 80 columns, where one row would drop the tail", () => {
    // Guard the premise: a single row genuinely cannot hold all five here.
    expect(fitShortcutHints(EIGHTY_COLUMN_BUDGET).length).toBeLessThan(SHORTCUT_HINTS.length);

    const rows = layoutShortcutHints(EIGHTY_COLUMN_BUDGET);

    expect(rows.flat()).toEqual([...SHORTCUT_HINTS]);
  });

  it("keeps every row inside the 80-column budget", () => {
    for (const row of layoutShortcutHints(EIGHTY_COLUMN_BUDGET)) {
      expect(shortcutHintsWidth(row)).toBeLessThanOrEqual(EIGHTY_COLUMN_BUDGET);
    }
  });

  it("collapses to a single row when the terminal is wide enough", () => {
    const rows = layoutShortcutHints(shortcutHintsWidth(SHORTCUT_HINTS));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([...SHORTCUT_HINTS]);
  });

  it("fills the first row greedily before starting the second", () => {
    const rows = layoutShortcutHints(EIGHTY_COLUMN_BUDGET);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(fitShortcutHints(EIGHTY_COLUMN_BUDGET));
  });

  it("never exceeds the row budget, dropping hints instead", () => {
    const rows = layoutShortcutHints(0);

    expect(rows.length).toBeLessThanOrEqual(MAX_SHORTCUT_HINT_ROWS);
    expect(rows.flat()).toEqual(SHORTCUT_HINTS.slice(0, MAX_SHORTCUT_HINT_ROWS));
  });
});
