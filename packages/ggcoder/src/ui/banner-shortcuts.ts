/**
 * The banner's keyboard-shortcut hint row, shared by BOTH renderers.
 *
 * The hints are rendered twice — live in Ink (`components/Banner.tsx`) and into
 * native scrollback (`terminal-history.ts`) — and a parity test asserts the two
 * produce identical lines. Owning the list and the layout rule here is what
 * keeps them from drifting apart (and from silently wrapping onto an unplanned
 * extra row on a narrow terminal, which breaks that parity).
 */
import stringWidth from "string-width";

export interface ShortcutHint {
  /** The key combo, rendered in the accent color. */
  key: string;
  /** What it does, rendered dim. */
  label: string;
}

/** Every hint, most-useful-first: the tail is dropped first when even the
 *  wrapped block can't fit, so the least-used hints are the ones that go. */
export const SHORTCUT_HINTS: readonly ShortcutHint[] = [
  { key: "Ctrl+T", label: "tasks" },
  { key: "Ctrl+S", label: "skills" },
  { key: "Ctrl+A", label: "autopilot" },
  { key: "Ctrl+E", label: "enhance" },
  { key: "Shift+Tab", label: "toggle thinking" },
];

/** Separator drawn between two hints. */
export const SHORTCUT_HINT_SEPARATOR = " · ";

/**
 * Visible width of a rendered hint row (colors add no printable width).
 *
 * Measured with `string-width`, not `.length`: this number decides where the
 * row breaks, and JS string length disagrees with terminal columns for CJK,
 * emoji, and combining marks. Today every label is ASCII so the two agree —
 * using the display metric keeps that an accident we don't depend on, and
 * matches how the rest of the banner (terminal-history.ts) measures text.
 */
export function shortcutHintsWidth(hints: readonly ShortcutHint[]): number {
  if (hints.length === 0) return 0;
  const text = hints.map((h) => `${h.key} ${h.label}`).join(SHORTCUT_HINT_SEPARATOR);
  return stringWidth(text);
}

/**
 * Pick the hints that fit on ONE row of `availableColumns`, dropping from the
 * end. Always keeps at least the first hint — a truncated row still beats an
 * empty one, and a terminal that narrow has bigger layout problems.
 */
export function fitShortcutHints(
  availableColumns: number,
  candidates: readonly ShortcutHint[] = SHORTCUT_HINTS,
): ShortcutHint[] {
  const hints = [...candidates];
  while (hints.length > 1 && shortcutHintsWidth(hints) > availableColumns) {
    hints.pop();
  }
  return hints;
}

/**
 * How many rows the hint block may occupy. The full row is 92 columns wide, so
 * a single row silently drops `Shift+Tab toggle thinking` on an 80-column
 * terminal — the most common width there is. Two rows keep every hint visible
 * without abbreviating the labels into guesswork, and still fit beside the
 * 6-line logo in the side-by-side layout.
 */
export const MAX_SHORTCUT_HINT_ROWS = 2;

/**
 * Lay the hints out across up to `MAX_SHORTCUT_HINT_ROWS` rows of
 * `availableColumns`, filling each row greedily before starting the next.
 * Hints that don't fit even then are dropped from the end.
 */
export function layoutShortcutHints(availableColumns: number): ShortcutHint[][] {
  const rows: ShortcutHint[][] = [];
  let remaining: readonly ShortcutHint[] = SHORTCUT_HINTS;
  while (remaining.length > 0 && rows.length < MAX_SHORTCUT_HINT_ROWS) {
    const row = fitShortcutHints(availableColumns, remaining);
    rows.push(row);
    remaining = remaining.slice(row.length);
  }
  return rows;
}
