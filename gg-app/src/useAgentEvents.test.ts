// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createRef } from "react";
import type { MutableRefObject } from "react";

// playSound builds an <audio> element and ./agent calls Tauri APIs at module
// scope (getCurrentWebviewWindow) which blow up in jsdom. Fully stub both. The
// hook only uses `listCommands` from ./agent at runtime (the rest is type-only,
// erased), so the mock just provides that, resolving empty so run_end's command
// refresh is a no-op.
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("./agent", () => ({ listCommands: vi.fn().mockResolvedValue([]) }));

import { useAgentEvents, type AgentEventsDeps } from "./useAgentEvents";
import type { Item } from "./App";
import type { SidecarEvent } from "./agent";
import type { LiveToolEntry } from "./LiveToolPanel";

const ev = (type: string, data: Record<string, unknown> = {}): SidecarEvent =>
  ({ type, data }) as SidecarEvent;

function setup(handleKenEvent: (e: SidecarEvent) => boolean = () => false) {
  let items: Item[] = [];
  let id = 0;
  const setItems = (u: Item[] | ((prev: Item[]) => Item[])): void => {
    items = typeof u === "function" ? u(items) : u;
  };
  const nextId = (): number => ++id;

  // Track the two outputs the assertions read; spy the rest so nothing throws.
  let liveToolFeed: LiveToolEntry[] = [];
  const setLiveToolFeed = vi.fn(
    (u: LiveToolEntry[] | ((p: LiveToolEntry[]) => LiveToolEntry[])) => {
      liveToolFeed = typeof u === "function" ? u(liveToolFeed) : u;
    },
  ) as unknown as AgentEventsDeps["setLiveToolFeed"];
  const setRunning = vi.fn() as unknown as AgentEventsDeps["setRunning"];
  const setTokens = vi.fn() as unknown as AgentEventsDeps["setTokens"];

  const noop = (): void => {};
  const deps: AgentEventsDeps = {
    setItems: setItems as AgentEventsDeps["setItems"],
    nextId,
    handleKenEvent,
    setState: noop as unknown as AgentEventsDeps["setState"],
    setTasks: noop as unknown as AgentEventsDeps["setTasks"],
    setProjectTasks: noop as unknown as AgentEventsDeps["setProjectTasks"],
    setStatus: noop as unknown as AgentEventsDeps["setStatus"],
    setRunning,
    setLiveToolFeed,
    setTokens,
    setContextTokens: noop as unknown as AgentEventsDeps["setContextTokens"],
    setDoneStatus: noop as unknown as AgentEventsDeps["setDoneStatus"],
    setIsThinking: noop as unknown as AgentEventsDeps["setIsThinking"],
    setThinkingStartTs: noop as unknown as AgentEventsDeps["setThinkingStartTs"],
    setThinkingAccumMs: noop as unknown as AgentEventsDeps["setThinkingAccumMs"],
    setPlanTotal: noop as unknown as AgentEventsDeps["setPlanTotal"],
    setPlanDone: noop as unknown as AgentEventsDeps["setPlanDone"],
    setSessionTitle: noop as unknown as AgentEventsDeps["setSessionTitle"],
    setPlanReview: noop as unknown as AgentEventsDeps["setPlanReview"],
    setQueuedCount: noop as unknown as AgentEventsDeps["setQueuedCount"],
    setAttachments: noop as unknown as AgentEventsDeps["setAttachments"],
    setCommands: noop as unknown as AgentEventsDeps["setCommands"],
    stateRef: createRef() as MutableRefObject<AgentEventsDeps["stateRef"]["current"]>,
    planDoneRef: { current: new Set<number>() },
    planTotalRef: { current: 0 },
    planReviewPathRef: { current: null },
    pendingPlanTotalRef: { current: null },
    stickToBottomRef: { current: true },
  };

  const hook = renderHook(() => useAgentEvents(deps));
  return {
    hook,
    getItems: () => items,
    getLiveToolFeed: () => liveToolFeed,
    setRunning,
    setTokens,
  };
}

describe("useAgentEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("text_delta streams assistant text into a single item", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: "Hello" }));
    });
    let items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "Hello" });

    // First-token path creates the bubble synchronously; a second delta buffers
    // via rAF, so flush it by ending the stream (endStreamingText drains buffer).
    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: " world" }));
      hook.result.current.endStreamingText();
    });
    items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "Hello world" });
  });

  it("tool_call_start then tool_call_end drive the live tool feed", () => {
    const { hook, getLiveToolFeed } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("tool_call_start", { toolCallId: "t1", name: "read", args: { file_path: "a.ts" } }),
      );
    });
    let feed = getLiveToolFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ toolCallId: "t1", status: "running" });

    act(() => {
      hook.result.current.handleEvent(ev("tool_call_end", { toolCallId: "t1", isError: false }));
    });
    feed = getLiveToolFeed();
    expect(feed[0]).toMatchObject({ toolCallId: "t1", status: "done" });
  });

  it("turn_end accumulates output tokens across turns", () => {
    const { hook, setTokens } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("turn_end", { usage: { outputTokens: 10 } }));
    });
    expect(setTokens).toHaveBeenLastCalledWith(10);
    act(() => {
      hook.result.current.handleEvent(ev("turn_end", { usage: { outputTokens: 5 } }));
    });
    // Accumulates (tokensRef is internal): 10 + 5 = 15.
    expect(setTokens).toHaveBeenLastCalledWith(15);
  });

  it("delegates ken_ events to handleKenEvent and does not handle them locally", () => {
    const handleKenEvent = vi.fn(() => true);
    const { hook, getItems, setRunning } = setup(handleKenEvent);
    act(() => {
      hook.result.current.handleEvent(ev("ken_text_delta", { text: "from ken" }));
      hook.result.current.handleEvent(ev("ken_run_start"));
    });
    expect(handleKenEvent).toHaveBeenCalledTimes(2);
    // Nothing handled locally: no assistant item, run state untouched.
    expect(getItems()).toHaveLength(0);
    expect(setRunning).not.toHaveBeenCalled();
  });

  it("run_end clears running state", () => {
    const { hook, setRunning } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("run_start"));
    });
    expect(setRunning).toHaveBeenLastCalledWith(true);
    act(() => {
      hook.result.current.handleEvent(ev("run_end", { cancelled: false }));
    });
    expect(setRunning).toHaveBeenLastCalledWith(false);
  });
});
