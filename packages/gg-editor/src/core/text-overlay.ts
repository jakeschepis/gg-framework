/**
 * Text-overlay builders — lower-thirds + title cards as ASS files.
 *
 * Why ASS and not ffmpeg drawtext: stock Homebrew ffmpeg ships WITHOUT
 * libfreetype, so drawtext returns "Unknown filter". The libass-backed
 * `subtitles` filter IS present in every build. We piggy-back on the same
 * burn_subtitles tool used for captions.
 *
 * ASS animation primitives we use (verified against zhw2590582/ArtPlayer,
 * Cyberbeing/xy-VSFilter, MPC-HC's RTS.cpp):
 *   {\move(x1,y1,x2,y2,t1,t2)}  — slide a tag from (x1,y1) to (x2,y2) between
 *                                 ms t1 and t2. Coordinates are PlayRes pixels.
 *   {\fad(in,out)}              — fade in over `in` ms, fade out over `out` ms.
 *   {\pos(x,y)}                 — absolute position override.
 *   {\an<n>}                    — alignment (numpad layout).
 *   {\fs<n>}                    — font size override.
 *   {\b1}                        — bold.
 *   {\c&Hbbggrr&}                — primary color override (BGR hex).
 *   {\3c&Hbbggrr&}               — outline color.
 *   {\bord<n>}                   — outline thickness.
 *   {\blur<n>}                   — gaussian blur.
 *
 * Output: a complete ASS file ready for `burn_subtitles` or NLE import.
 */

import { assColor, buildAss, type AssCue, type AssOptions, type AssStyle } from "./ass.js";

export type LowerThirdPosition =
  "bottom-left" | "bottom-center" | "bottom-right" | "top-left" | "top-center" | "top-right";

export type LowerThirdAnimation = "slide-left" | "slide-right" | "fade" | "none";

export interface LowerThird {
  /** Big text — name / topic. Required. */
  primaryText: string;
  /** Small text — title / role / source. Optional. */
  secondaryText?: string;
  /** When the lower-third appears, in seconds. */
  startSec: number;
  /** How long it stays on screen, in seconds. */
  durationSec: number;
  fontName?: string;
  /** Hex RRGGBB. Default white. */
  primaryColor?: string;
  /** Outline / accent color. Default black. */
  accentColor?: string;
  position?: LowerThirdPosition;
  animation?: LowerThirdAnimation;
  /** Distance from the canvas edge in pixels. Default 80. */
  marginPx?: number;
}

export type TitleCardAnimation = "fade-in-out" | "zoom-in" | "type-on" | "none";

export interface TitleCard {
  text: string;
  startSec: number;
  durationSec: number;
  fontName?: string;
  fontSize?: number;
  /** Hex RRGGBB. Default white. */
  color?: string;
  /** Numpad alignment (1=bot-left, 2=bot-center, ..., 5=middle, 9=top-right). */
  alignment?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  animation?: TitleCardAnimation;
}

export interface CanvasOpts {
  width: number;
  height: number;
}

/**
 * Build an ASS file containing one or more lower-thirds.
 *
 * Each lower-third becomes ONE ASS dialogue line whose text starts with
 * the `{\move(...)\fad(...)}` override block. The ASS engine handles all
 * tween math.
 */
export function buildLowerThirdAss(items: LowerThird[], canvas: CanvasOpts): string {
  if (items.length === 0) {
    throw new Error("buildLowerThirdAss: items must not be empty");
  }
  const styles: AssStyle[] = [
    {
      name: "Default",
      fontName: items[0].fontName ?? "Helvetica",
      fontSize: 56,
      primaryColor: "FFFFFF",
      outlineColor: "000000",
      outline: 3,
      shadow: 1,
      bold: true,
      // Bottom-left numpad alignment by default; per-cue overrides via {\anN}.
      alignment: 1,
      marginV: 80,
    },
  ];
  const cues: AssCue[] = [];
  for (const lt of items) {
    if (lt.durationSec <= 0) {
      throw new Error("lower-third durationSec must be > 0");
    }
    const margin = lt.marginPx ?? 80;
    const pos = lt.position ?? "bottom-left";
    const { x1, y1, x2, y2, an } = computeLowerThirdMotion(pos, lt.animation ?? "slide-left", {
      width: canvas.width,
      height: canvas.height,
      margin,
    });
    const fadeIn = 250;
    const fadeOut = 250;
    const moveDurationMs = 500;
    const fadeOnly = (lt.animation ?? "slide-left") === "fade" || lt.animation === "none";
    const overrides: string[] = [];
    overrides.push(`\\an${an}`);
    if (fadeOnly) {
      overrides.push(`\\pos(${x2},${y2})`);
    } else {
      overrides.push(`\\move(${x1},${y1},${x2},${y2},0,${moveDurationMs})`);
    }
    overrides.push(`\\fad(${fadeIn},${fadeOut})`);
    if (lt.primaryColor) overrides.push(`\\c${assColor(lt.primaryColor)}`);
    if (lt.accentColor) overrides.push(`\\3c${assColor(lt.accentColor)}`);
    const overridesBlock = `{${overrides.join("")}}`;
    const text = lt.secondaryText
      ? `${overridesBlock}${escapeText(lt.primaryText)}\\N${escapeText(lt.secondaryText)}`
      : `${overridesBlock}${escapeText(lt.primaryText)}`;
    cues.push({
      start: lt.startSec,
      end: lt.startSec + lt.durationSec,
      text,
    });
  }
  return buildAssRaw(
    {
      title: "lower-thirds",
      playResX: canvas.width,
      playResY: canvas.height,
      styles,
      cues,
    },
    canvas,
  );
}

/**
 * Build an ASS file containing one or more title cards. Centred big-type
 * cards with optional zoom-in / fade animations.
 */
export function buildTitleCardAss(items: TitleCard[], canvas: CanvasOpts): string {
  if (items.length === 0) {
    throw new Error("buildTitleCardAss: items must not be empty");
  }
  const styles: AssStyle[] = [
    {
      name: "Default",
      fontName: items[0].fontName ?? "Helvetica",
      fontSize: items[0].fontSize ?? 110,
      primaryColor: "FFFFFF",
      outlineColor: "000000",
      outline: 4,
      shadow: 0,
      bold: true,
      alignment: 5,
      marginV: 60,
    },
  ];
  const cues: AssCue[] = [];
  for (const tc of items) {
    if (tc.durationSec <= 0) {
      throw new Error("title card durationSec must be > 0");
    }
    const overrides: string[] = [];
    if (tc.alignment) overrides.push(`\\an${tc.alignment}`);
    if (tc.fontSize) overrides.push(`\\fs${tc.fontSize}`);
    if (tc.color) overrides.push(`\\c${assColor(tc.color)}`);
    const animation = tc.animation ?? "fade-in-out";
    if (animation === "fade-in-out") {
      overrides.push(`\\fad(400,400)`);
    } else if (animation === "zoom-in") {
      overrides.push(`\\fad(200,200)`);
      // Scale grows from 70% to 100% over the first half of the card.
      const halfMs = Math.round(tc.durationSec * 1000 * 0.5);
      overrides.push(`\\t(0,${halfMs},\\fscx100\\fscy100)`);
      // Open with smaller size; \t will animate up.
      overrides.unshift(`\\fscx70\\fscy70`);
    } else if (animation === "type-on") {
      // Approximate type-on by stepping fade-in across the duration.
      overrides.push(`\\fad(${Math.round(tc.durationSec * 1000 * 0.5)},200)`);
    }
    const text = `{${overrides.join("")}}${escapeText(tc.text)}`;
    cues.push({
      start: tc.startSec,
      end: tc.startSec + tc.durationSec,
      text,
    });
  }
  return buildAssRaw(
    {
      title: "title-cards",
      playResX: canvas.width,
      playResY: canvas.height,
      styles,
      cues,
    },
    canvas,
  );
}

/**
 * Some override tags (\move, \fad inside the dialogue text) need to survive
 * the existing ass.ts buildAss escaping. buildAss strips CR but doesn't
 * touch our override syntax, so we can pass through. This wrapper is here
 * mostly for future hardening.
 */
function buildAssRaw(opts: AssOptions, _canvas: CanvasOpts): string {
  return buildAss(opts);
}

interface MotionResult {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  an: number;
}

function computeLowerThirdMotion(
  pos: LowerThirdPosition,
  animation: LowerThirdAnimation,
  c: { width: number; height: number; margin: number },
): MotionResult {
  // ASS coords: (0,0) is top-left, +y is down. Positions reference the
  // alignment anchor — a lower-third with \an1 (bottom-left) is anchored at
  // the BOTTOM-LEFT of its bounding box.
  const an = positionToAlignment(pos);
  const final = anchorPoint(pos, c);
  let start = { ...final };
  if (animation === "slide-left") {
    start = { x: -c.width, y: final.y };
  } else if (animation === "slide-right") {
    start = { x: c.width * 2, y: final.y };
  } else if (animation === "fade" || animation === "none") {
    start = { ...final };
  }
  return { x1: start.x, y1: start.y, x2: final.x, y2: final.y, an };
}

function anchorPoint(
  pos: LowerThirdPosition,
  c: { width: number; height: number; margin: number },
): { x: number; y: number } {
  const m = c.margin;
  switch (pos) {
    case "bottom-left":
      return { x: m, y: c.height - m };
    case "bottom-center":
      return { x: c.width / 2, y: c.height - m };
    case "bottom-right":
      return { x: c.width - m, y: c.height - m };
    case "top-left":
      return { x: m, y: m };
    case "top-center":
      return { x: c.width / 2, y: m };
    case "top-right":
      return { x: c.width - m, y: m };
  }
}

function positionToAlignment(pos: LowerThirdPosition): number {
  // Numpad layout: 1=bot-left, 2=bot-center, 3=bot-right, 7=top-left,
  // 8=top-center, 9=top-right.
  switch (pos) {
    case "bottom-left":
      return 1;
    case "bottom-center":
      return 2;
    case "bottom-right":
      return 3;
    case "top-left":
      return 7;
    case "top-center":
      return 8;
    case "top-right":
      return 9;
  }
}

function escapeText(s: string): string {
  // Keep ASS override braces intact; strip CR so cues stay single-line.
  // Real newlines become hard-break \N (matches buildAss's own escaping for
  // plain text but we need to do it manually because we already wrap our
  // text with overrides).
  return s.replace(/\r\n?|\n/g, "\\N");
}
