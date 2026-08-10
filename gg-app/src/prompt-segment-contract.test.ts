import { describe, expect, it } from "vitest";
import type { EnhanceResult, PromptSegment } from "./agent";

/**
 * Parity guard for the `/enhance` wire shape, webview side.
 *
 * `PromptSegment` / `EnhanceResult` in `./agent.ts` are a hand-written mirror of
 * the canonical declarations in
 * `packages/ggcoder/src/utils/prompt-enhancer.ts` (serialised verbatim by the
 * sidecar's `POST /enhance` handler in `packages/ggcoder/src/app-sidecar.ts`).
 * The two packages typecheck independently and this bundle cannot import from
 * the sidecar package, so drift is invisible to `tsc` — a new segment `kind`
 * or a renamed `original`/`note` would reach `EnhancedSegments` in
 * `./PromptEnhancement.tsx` as an unhandled shape and render blank.
 *
 * The pins below fail `pnpm --filter gg-app check` (and `pnpm build`) when this
 * side changes. The counterpart guard —
 * `packages/ggcoder/src/utils/prompt-enhancer.contract.test.ts` — compares the
 * two source files directly and fails when either side moves alone.
 */

/** True only when A and B are the exact same type (not merely assignable). */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** No-op at runtime; the type argument is the assertion. */
function pinned<_Check extends true>(): void {}

/**
 * The wire contract, spelled out. Keep in lockstep with the identical table in
 * `packages/ggcoder/src/utils/prompt-enhancer.contract.test.ts`.
 */
const SEGMENT_KEYS = {
  text: ["kind", "text"],
  term: ["kind", "text", "original", "note"],
} as const satisfies Record<PromptSegment["kind"], readonly string[]>;

const RESULT_KEYS = ["enhanced", "segments"] as const;

type KeysOf<K extends PromptSegment["kind"]> = keyof Extract<PromptSegment, { kind: K }> & string;

/** A literal `/enhance` response, exactly as the sidecar serialises it. */
const WIRE_SAMPLE: EnhanceResult = {
  enhanced: "Add a debounce to the search input.",
  segments: [
    { kind: "text", text: "Add a " },
    { kind: "term", text: "debounce", original: "wait a bit", note: "delays rapid calls" },
    { kind: "text", text: " to the search input." },
  ],
};

describe("PromptSegment / EnhanceResult wire contract", () => {
  it("pins each segment variant's exact key set (compile-time)", () => {
    pinned<Equal<KeysOf<"text">, (typeof SEGMENT_KEYS)["text"][number]>>();
    pinned<Equal<KeysOf<"term">, (typeof SEGMENT_KEYS)["term"][number]>>();
    pinned<Equal<keyof EnhanceResult & string, (typeof RESULT_KEYS)[number]>>();
    // `satisfies Record<PromptSegment["kind"], …>` above additionally fails to
    // compile the moment a third `kind` joins the union without being pinned.
    expect(Object.keys(SEGMENT_KEYS).sort()).toEqual(["term", "text"]);
  });

  it("keeps a real sidecar payload inside the pinned keys", () => {
    expect(Object.keys(WIRE_SAMPLE).sort()).toEqual([...RESULT_KEYS].sort());
    for (const seg of WIRE_SAMPLE.segments) {
      const allowed: readonly string[] = SEGMENT_KEYS[seg.kind];
      expect(Object.keys(seg).filter((k) => !allowed.includes(k))).toEqual([]);
    }
  });

  it("has a rendering branch for every kind (compile-time exhaustiveness)", () => {
    // Mirrors the branching in EnhancedSegments (./PromptEnhancement.tsx): a new
    // kind makes `seg` non-`never` here and fails the build instead of silently
    // rendering nothing.
    const describeSegment = (seg: PromptSegment): string => {
      if (seg.kind === "text") return seg.text;
      if (seg.kind === "term") return `${seg.text} (you said "${seg.original}")`;
      const unhandled: never = seg;
      return unhandled;
    };
    expect(WIRE_SAMPLE.segments.map(describeSegment).join("")).toBe(
      'Add a debounce (you said "wait a bit") to the search input.',
    );
  });
});
