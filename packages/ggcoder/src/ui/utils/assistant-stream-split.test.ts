import { describe, expect, it } from "vitest";
import { splitAssistantStreamingText } from "./assistant-stream-split.js";

describe("splitAssistantStreamingText", () => {
  it("keeps single-block text live (nothing to flush yet)", () => {
    const cases = [
      "Dr. Jones keeps a notebook full of odd theories and coffee stains.",
      "1. Dr. Jones keeps a spare notebook.\n2. Dr. Jones believes every mystery deserves coffee.",
      "- Dr. Jones once labeled an entire filing cabinet important.\n- Dr. Jones explains with metaphors.",
    ];
    for (const text of cases) {
      expect(splitAssistantStreamingText(text)).toEqual({ flushedText: "", remainingText: text });
    }
  });

  it("flushes completed paragraphs and keeps the trailing block live", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three in progress";
    const { flushedText, remainingText } = splitAssistantStreamingText(text);
    expect(flushedText).toBe("Paragraph one.\n\nParagraph two.\n\n");
    expect(remainingText).toBe("Paragraph three in progress");
  });

  it("is lossless: flushedText + remainingText === text", () => {
    const text = "A.\n\nB.\n\nC still going";
    const { flushedText, remainingText } = splitAssistantStreamingText(text);
    expect(flushedText + remainingText).toBe(text);
  });

  it("never splits at a blank line inside an open code fence", () => {
    // The blank line between the two consts is inside an unterminated fence and
    // must not be a split point; only the paragraph break before the fence is.
    const text = "Here is code:\n\n```ts\nconst one = 1;\n\nconst two = 2;";
    const { flushedText, remainingText } = splitAssistantStreamingText(text);
    expect(flushedText).toBe("Here is code:\n\n");
    expect(remainingText).toBe("```ts\nconst one = 1;\n\nconst two = 2;");
  });

  it("flushes past a closed code fence", () => {
    const text = "Intro.\n\n```ts\nconst x = 1;\n```\n\nTrailing in progress";
    const { flushedText, remainingText } = splitAssistantStreamingText(text);
    expect(flushedText).toBe("Intro.\n\n```ts\nconst x = 1;\n```\n\n");
    expect(remainingText).toBe("Trailing in progress");
  });
});
