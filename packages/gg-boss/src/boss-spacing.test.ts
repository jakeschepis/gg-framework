import { describe, expect, it } from "vitest";
import {
  getTranscriptItemMarginTop,
  shouldSeparateTranscriptItemKinds,
} from "@kenkaiiii/ggcoder/ui/transcript/spacing";
import { BOSS_SPACING_KINDS, BOSS_COMPACT_BOUNDARIES } from "./boss-spacing.js";

/**
 * The live pane (getTranscriptItemMarginTop) and the scrollback printer
 * (shouldSeparateTranscriptItemKinds) must agree for every boundary, or an
 * item's blank-line treatment changes when it flushes from live → Static.
 */
describe("boss transcript spacing parity", () => {
  const kinds = [...BOSS_SPACING_KINDS];

  for (const previousKind of kinds) {
    for (const currentKind of kinds) {
      it(`live margin matches scrollback separator for ${previousKind}→${currentKind}`, () => {
        const scrollbackSeparates = shouldSeparateTranscriptItemKinds({
          previousKind,
          currentKind,
          spacingKinds: BOSS_SPACING_KINDS,
          compactBoundaries: BOSS_COMPACT_BOUNDARIES,
        });
        const liveMargin = getTranscriptItemMarginTop({
          // assistant rows only space when they have text — supply some so the
          // assistant branch reduces to the same boundary check.
          item: { id: "x", kind: currentKind, text: "body" },
          previousLiveItem: { id: "p", kind: previousKind },
          spacingKinds: BOSS_SPACING_KINDS,
          compactBoundaries: BOSS_COMPACT_BOUNDARIES,
        });
        expect(liveMargin === 1).toBe(scrollbackSeparates);
      });
    }
  }
});
