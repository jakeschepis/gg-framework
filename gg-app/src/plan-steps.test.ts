import { describe, expect, it } from "vitest";
import { hasDoneMarker, segmentDoneMarkers, findCompletedSteps } from "./plan-steps";

describe("segmentDoneMarkers", () => {
  it("splits a single trailing [DONE:n] marker into text + done segments", () => {
    expect(segmentDoneMarkers("Did the work. [DONE:6]")).toEqual([
      { kind: "text", text: "Did the work. " },
      { kind: "done", stepNum: 6 },
    ]);
  });

  it("splits multiple markers in order", () => {
    expect(segmentDoneMarkers("a [DONE:1] b [DONE:2] c")).toEqual([
      { kind: "text", text: "a " },
      { kind: "done", stepNum: 1 },
      { kind: "text", text: " b " },
      { kind: "done", stepNum: 2 },
      { kind: "text", text: " c" },
    ]);
  });

  it("strips backtick-wrapped markers", () => {
    expect(segmentDoneMarkers("done `[DONE:3]`")).toEqual([
      { kind: "text", text: "done " },
      { kind: "done", stepNum: 3 },
    ]);
  });

  // Regression: this mirrors TranscriptRow's real render path. A prior shared
  // global regex made hasDoneMarker advance lastIndex, causing segmentDoneMarkers
  // to skip the only marker and leak "[DONE:6]" into the prose verbatim.
  it("segments correctly after hasDoneMarker is called first", () => {
    const text = "Did the work. [DONE:6]";
    expect(hasDoneMarker(text)).toBe(true);
    expect(segmentDoneMarkers(text)).toEqual([
      { kind: "text", text: "Did the work. " },
      { kind: "done", stepNum: 6 },
    ]);
    // Idempotent across repeated calls.
    expect(hasDoneMarker(text)).toBe(true);
    expect(segmentDoneMarkers(text)).toEqual([
      { kind: "text", text: "Did the work. " },
      { kind: "done", stepNum: 6 },
    ]);
  });

  it("returns a single text segment when there are no markers", () => {
    expect(segmentDoneMarkers("just prose")).toEqual([{ kind: "text", text: "just prose" }]);
  });
});

describe("findCompletedSteps", () => {
  it("collects every marked step number", () => {
    expect(findCompletedSteps("a [DONE:1] b [DONE:3]")).toEqual([1, 3]);
  });
});
