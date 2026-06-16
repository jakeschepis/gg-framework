import { describe, expect, it } from "vitest";
import { lastVisibleTranscriptItem, itemHasImagePreviews } from "./app-items.js";

describe("lastVisibleTranscriptItem", () => {
  it("returns the last item when nothing is panel-replaced", () => {
    const items = [
      { kind: "user", id: "u1" },
      { kind: "assistant", id: "a1" },
    ];
    expect(lastVisibleTranscriptItem(items)?.id).toBe("a1");
  });

  it("skips panel-replaced tool items so the boundary is the prior visible row", () => {
    const items = [
      { kind: "user", id: "u1" },
      { kind: "tool_start", id: "t1" },
      { kind: "tool_done", id: "t2" },
      { kind: "tool_group", id: "t3" },
    ];
    expect(lastVisibleTranscriptItem(items)?.id).toBe("u1");
  });

  it("keeps image-bearing tool rows since they still render", () => {
    const items = [
      { kind: "user", id: "u1" },
      { kind: "tool_done", id: "t1", imagePreviews: [{ base64: "x" }] },
    ];
    expect(lastVisibleTranscriptItem(items)?.id).toBe("t1");
  });

  it("returns undefined when every item is panel-replaced", () => {
    const items = [
      { kind: "tool_start", id: "t1" },
      { kind: "tool_done", id: "t2" },
    ];
    expect(lastVisibleTranscriptItem(items)).toBeUndefined();
  });

  it("returns undefined for an empty list", () => {
    expect(lastVisibleTranscriptItem([])).toBeUndefined();
  });
});

describe("itemHasImagePreviews", () => {
  it("is true for items carrying image previews", () => {
    expect(itemHasImagePreviews({ kind: "user", imagePreviews: [{ base64: "AAAA" }] })).toBe(true);
  });

  it("is false for items with no previews or an empty list", () => {
    expect(itemHasImagePreviews({ kind: "assistant" })).toBe(false);
    expect(itemHasImagePreviews({ kind: "tool_done", imagePreviews: [] })).toBe(false);
  });

  it("detects an image anywhere in a transcript via some()", () => {
    const history = [
      { kind: "assistant", imagePreviews: undefined },
      { kind: "user", imagePreviews: [{ base64: "x" }] },
    ];
    expect(history.some(itemHasImagePreviews)).toBe(true);
  });
});
