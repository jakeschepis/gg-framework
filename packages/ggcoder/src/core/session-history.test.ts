import { describe, expect, it } from "vitest";
import type {
  AutopilotMarkerPayload,
  AppMarkerPayload,
  KenTurnPayload,
} from "./session-manager.js";
import { STEERING_PREFIX } from "./steering.js";
import { frameAutopilotInjection } from "./autopilot-cycle.js";
import {
  normalizeAutopilotMarkersForHistory,
  normalizeAppMarkersForHistory,
  normalizeKenTurnsForHistory,
  restoreUserRow,
  restoreAssistantTexts,
} from "./session-history.js";

describe("normalizeAutopilotMarkersForHistory", () => {
  it("drops out-of-range compacted-session markers and dedupes exact all-clear rows", () => {
    const markers: AutopilotMarkerPayload[] = [
      { version: 1, phase: "done", afterMessageCount: 2 },
      { version: 1, phase: "done", afterMessageCount: 2 },
      { version: 1, phase: "done", afterMessageCount: 9 },
      { version: 1, phase: "human", afterMessageCount: 3, reason: "Needs user approval." },
      { version: 1, phase: "done", afterMessageCount: 12 },
    ];

    const restored = normalizeAutopilotMarkersForHistory(markers, 4);

    expect(restored).toEqual([
      { version: 1, phase: "done", afterMessageCount: 2, copySeed: "done\u00002\u0000\u0000" },
      {
        version: 1,
        phase: "human",
        afterMessageCount: 3,
        reason: "Needs user approval.",
        copySeed: "human\u00003\u0000Needs user approval.\u0000",
      },
    ]);
    expect(restored.filter((m) => m.phase === "done")).toHaveLength(1);
  });
});

describe("normalizeAppMarkersForHistory", () => {
  it("drops out-of-range markers and dedupes exact payloads", () => {
    const markers: AppMarkerPayload[] = [
      { version: 1, kind: "plan", afterMessageCount: 1, data: { reason: "complex change" } },
      { version: 1, kind: "plan", afterMessageCount: 1, data: { reason: "complex change" } },
      { version: 1, kind: "task", afterMessageCount: 9, data: { title: "stale task" } },
    ];
    expect(normalizeAppMarkersForHistory(markers, 4)).toEqual([
      { version: 1, kind: "plan", afterMessageCount: 1, data: { reason: "complex change" } },
    ]);
  });
});

describe("normalizeKenTurnsForHistory", () => {
  it("clamps stale anchors to the last message instead of dropping, and dedupes", () => {
    const turns: KenTurnPayload[] = [
      { version: 1, question: "why?", reply: "because", afterMessageCount: 2 },
      { version: 1, question: "why?", reply: "because", afterMessageCount: 2 },
      { version: 1, question: "later q", reply: "later a", afterMessageCount: 50 },
    ];
    expect(normalizeKenTurnsForHistory(turns, 4)).toEqual([
      { version: 1, question: "why?", reply: "because", afterMessageCount: 2 },
      { version: 1, question: "later q", reply: "later a", afterMessageCount: 4 },
    ]);
  });
});

describe("restoreUserRow", () => {
  it("strips the mid-run steering wrapper so queued prompts resume clean", () => {
    const row = restoreUserRow(`${STEERING_PREFIX}also add dark mode`);
    expect(row.text).toBe("also add dark mode");
  });

  it("strips the autopilot preamble so injected prompts resume as the clean body", () => {
    const row = restoreUserRow(frameAutopilotInjection("Add a test for the login flow."));
    expect(row.text).toBe("Add a test for the login flow.");
    expect(row.text).not.toContain("[Autopilot]");
  });

  it("drops attachment notes and the attached-files block, keeps typed text + images", () => {
    const row = restoreUserRow([
      {
        type: "text",
        text: "what's in this screenshot?\n\nAttached files (inspect with your tools):\n- notes.txt (saved at /p/notes.txt)",
      },
      { type: "image", mediaType: "image/png", data: "aGk=" },
      { type: "text", text: "[Image saved at /p/.gg/uploads/x.png]" },
    ]);
    expect(row.text).toBe("what's in this screenshot?");
    expect(row.images).toEqual(["data:image/png;base64,aGk="]);
    expect(row.videoWarning).toBe(false);
  });

  it("flags the non-native-video note so resume re-shows the live info row", () => {
    const row = restoreUserRow([
      { type: "text", text: "summarize this clip" },
      {
        type: "text",
        text: "[User attached a video file at /p/clip.mp4. You cannot watch video directly; if needed, use ffmpeg to extract frames or audio.]",
      },
    ]);
    expect(row.text).toBe("summarize this clip");
    expect(row.videoWarning).toBe(true);
  });
});

describe("restoreAssistantTexts", () => {
  it("keeps server-tool text splits as separate bubbles", () => {
    expect(
      restoreAssistantTexts([
        { type: "text", text: "Let me search for that." },
        { type: "server_tool_call", id: "st1", name: "web_search", args: {} },
        { type: "text", text: "Found it — here's the answer." },
      ] as never),
    ).toEqual(["Let me search for that.", "Found it — here's the answer."]);
  });

  it("passes plain string content through as one bubble", () => {
    expect(restoreAssistantTexts("hello")).toEqual(["hello"]);
    expect(restoreAssistantTexts("  ")).toEqual([]);
  });
});
