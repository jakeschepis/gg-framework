import { describe, it, expect } from "vitest";
import { chunkFile, tokenize, bm25Rank, rankFiles } from "./code-retrieval.js";
import { grade } from "./semantic-search-benchmark.js";

/**
 * Deterministic tests for the retrieval half of the semantic-search benchmark.
 * The token-saving claim is only meaningful if AST chunking, tokenization, BM25
 * ranking, and the answer grader are correct. We test parsing across every node
 * kind, full-body capture, camelCase splitting, ranking relevance, the top-k
 * cap, and the grader's all-tokens-required strictness.
 */

const SAMPLE = `
import { x } from "y";

export interface Session { id: string; userId: string; }

export type Mode = "code" | "conversation" | "both";

export enum Color { Red, Green }

const DEFAULT_TTL = 3000;

/** Sign a session token with HMAC-SHA256. */
export function signSessionToken(s: Session, secret: string): string {
  return s.id + secret + "SIGNED_MARKER";
}

export class LruCache {
  evictLeastRecentlyUsed(): void {}
}
`;

describe("chunkFile (AST chunking)", () => {
  const chunks = chunkFile("sample.ts", SAMPLE);
  const symbols = chunks.map((c) => c.symbol);

  it("1. extracts a top-level function declaration by name", () => {
    expect(symbols).toContain("signSessionToken");
  });

  it("2. extracts class and interface declarations", () => {
    expect(symbols).toContain("LruCache");
    expect(symbols).toContain("Session");
  });

  it("3. extracts type alias, enum, and top-level const", () => {
    expect(symbols).toContain("Mode");
    expect(symbols).toContain("Color");
    expect(symbols).toContain("DEFAULT_TTL");
  });

  it("4. captures the FULL body text of a chunk (not just the signature)", () => {
    const fn = chunks.find((c) => c.symbol === "signSessionToken")!;
    expect(fn.text).toContain("SIGNED_MARKER");
    expect(fn.file).toBe("sample.ts");
  });

  it("5. ignores import statements (no spurious chunk)", () => {
    expect(symbols).not.toContain("x");
    expect(chunks.length).toBe(6); // Session, Mode, Color, DEFAULT_TTL, signSessionToken, LruCache
  });
});

describe("tokenize", () => {
  it("6. splits camelCase identifiers into separate terms", () => {
    const toks = tokenize("resolveCredentials");
    expect(toks).toContain("resolve");
    expect(toks).toContain("credentials");
  });

  it("7. lowercases and splits on non-word boundaries (snake/punctuation)", () => {
    const toks = tokenize("DEFAULT_TTL = signSessionToken()");
    expect(toks).toEqual(expect.arrayContaining(["default", "ttl", "sign", "session", "token"]));
    expect(toks.every((t) => t === t.toLowerCase())).toBe(true);
  });
});

describe("bm25Rank + rankFiles (retrieval)", () => {
  const chunks = chunkFile("sample.ts", SAMPLE);

  it("8. ranks the chunk matching the query's terms first", () => {
    const top = bm25Rank("how are session tokens signed", chunks, 1);
    expect(top[0]!.symbol).toBe("signSessionToken");
  });

  it("9. never returns more than top-k chunks", () => {
    expect(bm25Rank("session", chunks, 2).length).toBeLessThanOrEqual(2);
    expect(bm25Rank("session", chunks, 100).length).toBe(chunks.length);
  });

  it("10. rankFiles surfaces the relevant file and grade requires ALL tokens", () => {
    const files = new Map<string, string>([
      ["auth.ts", SAMPLE],
      ["unrelated.ts", "export const pi = 3.14; // geometry helpers only"],
    ]);
    expect(rankFiles("sign a session token", files, 1)[0]).toBe("auth.ts");

    // grade is strict: every required token must be present (case-insensitive).
    expect(
      grade("It uses signSessionToken with refresh logic", ["signsessiontoken", "refresh"]),
    ).toBe(true);
    expect(grade("It uses signSessionToken", ["signsessiontoken", "refresh"])).toBe(false);
  });
});
