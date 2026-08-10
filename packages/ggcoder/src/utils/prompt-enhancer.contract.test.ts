import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnhanced, type EnhanceResult, type PromptSegment } from "./prompt-enhancer.js";

/**
 * Parity guard for the `/enhance` wire shape.
 *
 * `EnhanceResult` is serialised verbatim by the sidecar (`app-sidecar.ts`, the
 * `POST /enhance` handler) and re-declared by hand in the webview at
 * `gg-app/src/agent.ts` — the two packages typecheck independently and the
 * webview cannot import from this package, so `tsc` alone can never see them
 * drift apart. This file is the thing that notices:
 *
 *  1. Compile-time pins below fail `pnpm --filter @kenkaiiii/ggcoder check`
 *     when a key is added/renamed/removed or a new `kind` appears here.
 *  2. The mirror test at the bottom fails `pnpm --filter @kenkaiiii/ggcoder test`
 *     when this file and `gg-app/src/agent.ts` stop declaring the same shape.
 *
 * The matching guard on the other side is
 * `gg-app/src/prompt-segment-contract.test.ts`.
 */

/** True only when A and B are the exact same type (not merely assignable). */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** No-op at runtime; the type argument is the assertion. */
function pinned<_Check extends true>(): void {}

/**
 * The wire contract, spelled out. Keep in lockstep with the identical table in
 * `gg-app/src/prompt-segment-contract.test.ts`.
 */
const SEGMENT_KEYS = {
  text: ["kind", "text"],
  term: ["kind", "text", "original", "note"],
} as const satisfies Record<PromptSegment["kind"], readonly string[]>;

const RESULT_KEYS = ["enhanced", "segments"] as const;

type KeysOf<K extends PromptSegment["kind"]> = keyof Extract<PromptSegment, { kind: K }> & string;

describe("PromptSegment / EnhanceResult wire contract", () => {
  it("pins each segment variant's exact key set (compile-time)", () => {
    pinned<Equal<KeysOf<"text">, (typeof SEGMENT_KEYS)["text"][number]>>();
    pinned<Equal<KeysOf<"term">, (typeof SEGMENT_KEYS)["term"][number]>>();
    pinned<Equal<keyof EnhanceResult & string, (typeof RESULT_KEYS)[number]>>();
    // `satisfies Record<PromptSegment["kind"], …>` above additionally fails to
    // compile the moment a third `kind` joins the union without being pinned.
    expect(Object.keys(SEGMENT_KEYS).sort()).toEqual(["term", "text"]);
  });

  it("emits only pinned kinds and keys at runtime", () => {
    const result = parseEnhanced(
      "Add a \u27E6debounce\u00A6wait a bit before searching\u00A6delays rapid calls\u27E7 to the input, " +
        "then \u27E6memoize\u00A6remember the answer\u27E7 the result.",
    );
    expect(Object.keys(result).sort()).toEqual([...RESULT_KEYS].sort());
    expect(result.segments.length).toBeGreaterThan(1);
    for (const seg of result.segments) {
      const allowed: readonly string[] | undefined = SEGMENT_KEYS[seg.kind];
      expect(allowed, `unpinned segment kind: ${String(seg.kind)}`).toBeDefined();
      expect(Object.keys(seg).filter((k) => !allowed!.includes(k))).toEqual([]);
    }
    // The teaching fields survive serialisation as their pinned names.
    const term = result.segments.find((s) => s.kind === "term");
    expect(term).toMatchObject({ kind: "term", text: "debounce", original: expect.any(String) });
  });

  it("matches the hand-written mirror in gg-app/src/agent.ts", () => {
    const canonical = new URL("./prompt-enhancer.ts", import.meta.url);
    const mirror = new URL("../../../../gg-app/src/agent.ts", import.meta.url);
    expect(
      declaredShape(readFileSync(mirror, "utf8")),
      "gg-app/src/agent.ts no longer declares PromptSegment + EnhanceResult — " +
        "if the mirror moved, update this path and gg-app/src/prompt-segment-contract.test.ts",
    ).not.toBe("");
    expect(
      declaredShape(readFileSync(mirror, "utf8")),
      "PromptSegment/EnhanceResult drifted between " +
        "packages/ggcoder/src/utils/prompt-enhancer.ts (canonical, serialised by " +
        "app-sidecar.ts POST /enhance) and gg-app/src/agent.ts (webview mirror). " +
        "Update BOTH declarations plus the pinned key tables in this file and " +
        "gg-app/src/prompt-segment-contract.test.ts.",
    ).toBe(declaredShape(readFileSync(canonical, "utf8")));
  });
});

/**
 * Extract the `PromptSegment` + `EnhanceResult` declarations from TypeScript
 * source as one whitespace- and comment-insensitive string, so reformatting or
 * a differing doc comment doesn't trip the guard — only the shape does.
 */
function declaredShape(source: string): string {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const segment = /export type PromptSegment =([\s\S]*?);[ \t]*\r?\n/.exec(code);
  const result = /export interface EnhanceResult \{([\s\S]*?)\r?\n\}/.exec(code);
  if (!segment || !result) return "";
  return `PromptSegment=${normalize(segment[1])};EnhanceResult={${normalize(result[1])}}`;
}

function normalize(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s*([{}|;:,?])\s*/g, "$1")
    .replace(/^\|/, "")
    .replace(/;$/, "")
    .trim();
}
