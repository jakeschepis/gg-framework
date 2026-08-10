import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StreamOptions } from "@kenkaiiii/gg-ai";

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, stream: vi.fn() };
});

// Must import AFTER the mock is registered.
import { stream } from "@kenkaiiii/gg-ai";
import { enhanceDraft, enhancePrompt, parseEnhanced } from "./prompt-enhancer.js";

// The marker delimiters, spelled out by codepoint so a stray editor
// normalisation of the literal glyphs can't quietly weaken these tests.
const OPEN = "\u27E6"; // ⟦
const CLOSE = "\u27E7"; // ⟧
const BAR = "\u00A6"; // ¦

/** Minimal StreamResult stand-in: thenable + `.response` promise. */
function mockStreamResult(text: string) {
  const response = Promise.resolve({
    message: { role: "assistant", content: text },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  return {
    response,
    then: (onFulfilled: (v: unknown) => unknown) => response.then(onFulfilled),
    events: {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    },
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ done: true as const, value: undefined }) };
    },
  };
}

const streamMock = vi.mocked(stream);

function lastStreamOptions(): StreamOptions {
  expect(streamMock).toHaveBeenCalled();
  return streamMock.mock.calls.at(-1)![0] as StreamOptions;
}

describe("prompt enhancer credential pass-through", () => {
  beforeEach(() => {
    streamMock.mockReset();
    streamMock.mockImplementation(
      () => mockStreamResult("Add debouncing to the search input.") as never,
    );
  });

  it("forwards projectId to stream()", async () => {
    await enhancePrompt({
      provider: "gemini",
      model: "gemini-3-pro",
      prompt: "make the search not spam the server",
      apiKey: "token",
      accountId: "acct-1",
      projectId: "my-code-assist-project",
    });

    // Regression guard: Gemini Code Assist omits the `project` field entirely
    // when projectId is undefined, so enhancement fails for OAuth users with no
    // GOOGLE_CLOUD_PROJECT env var.
    expect(lastStreamOptions().projectId).toBe("my-code-assist-project");
  });

  it("carries projectId through enhanceDraft's ...rest spread", async () => {
    await enhanceDraft({
      provider: "gemini",
      model: "gemini-3-pro",
      prompt: "make the search not spam the server",
      cwd: process.cwd(),
      apiKey: "token",
      accountId: "acct-1",
      projectId: "my-code-assist-project",
    });

    const opts = lastStreamOptions();
    expect(opts.projectId).toBe("my-code-assist-project");
    // The sibling credentials keep flowing too.
    expect(opts.accountId).toBe("acct-1");
    expect(opts.apiKey).toBe("token");
  });

  it("leaves projectId undefined when the caller has none", async () => {
    await enhancePrompt({
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "tidy this up",
      apiKey: "token",
    });

    expect(lastStreamOptions().projectId).toBeUndefined();
  });
});

describe("parseEnhanced", () => {
  it("parses a well-formed three-field marker into a term segment", () => {
    const { segments } = parseEnhanced(
      `Add ${OPEN}debounce${BAR}wait a bit before firing${BAR}delays calls until input settles${CLOSE} to the search box.`,
    );

    expect(segments).toContainEqual({
      kind: "term",
      text: "debounce",
      original: "wait a bit before firing",
      note: "delays calls until input settles",
    });
  });

  it("parses the two-field form into a term segment with no note", () => {
    const { segments } = parseEnhanced(
      `Use ${OPEN}memoization${BAR}remember the answer${CLOSE} for the expensive call.`,
    );

    expect(segments).toContainEqual({
      kind: "term",
      text: "memoization",
      original: "remember the answer",
    });
  });

  it("unwraps a bare marker with no original field, leaking no brackets", () => {
    // Observed Claude failure mode: it emits ⟦term⟧ with no ¦original. There is
    // nothing to teach, so it must degrade to plain text — never raw brackets.
    //
    // The marker is deliberately punctuation-adjacent: the orphan-glyph safety
    // net further down substitutes a SPACE for each delimiter, so without the
    // dedicated unwrap this reads "debounce , then". Only the real unwrap joins
    // cleanly — that is what makes this test pin the unwrap, not the safety net.
    const { enhanced } = parseEnhanced(`Add ${OPEN}debounce${CLOSE}, then test it.`);

    expect(enhanced).toBe("Add debounce, then test it.");
  });

  it("unwraps a fenced body", () => {
    const { enhanced } = parseEnhanced("```\nAdd retry with backoff to the fetch.\n```");

    expect(enhanced).toBe("Add retry with backoff to the fetch.");
  });

  it("strips a leading conversational preamble line", () => {
    const { enhanced } = parseEnhanced(
      "Here's the improved prompt:\nAdd retry with backoff to the fetch.",
    );

    expect(enhanced).toBe("Add retry with backoff to the fetch.");
  });

  it("replaces orphan delimiters with a space instead of gluing words together", () => {
    // An unclosed marker leaves orphan ⟦ and ¦ glyphs. Dropping them outright
    // would produce "debounceprevent"; they must collapse to a single space.
    const { enhanced } = parseEnhanced(`Use ${OPEN}debounce${BAR}prevent extra calls`);

    expect(enhanced).toBe("Use debounce prevent extra calls");
  });

  it("returns exactly one text segment when there are no markers", () => {
    const result = parseEnhanced("Refactor the parser for clarity.");

    expect(result).toEqual({
      enhanced: "Refactor the parser for clarity.",
      segments: [{ kind: "text", text: "Refactor the parser for clarity." }],
    });
  });

  it("keeps enhanced equal to the joined segment text", () => {
    // The UI renders `segments`; the agent receives `enhanced`. If these ever
    // diverge, the user approves one prompt and the agent runs a different one.
    const { enhanced, segments } = parseEnhanced(
      `Add ${OPEN}debounce${BAR}wait a bit${BAR}delays calls${CLOSE} and ` +
        `${OPEN}memoization${BAR}remember results${CLOSE} to ${OPEN}search${CLOSE}.${BAR}`,
    );

    expect(enhanced).toBe(segments.map((s) => s.text).join(""));
  });
});
