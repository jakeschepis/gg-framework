import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { bossStore, getBossState, type HistoryItem } from "./boss-store.js";

function initStore(): void {
  bossStore.init({
    bossProvider: "anthropic",
    bossModel: "claude-test",
    workerProvider: "anthropic",
    workerModel: "claude-test",
    loggedInProviders: ["anthropic"],
    workers: [],
  });
  bossStore.startStreaming();
}

function group(
  items: readonly HistoryItem[],
): Extract<HistoryItem, { kind: "tool_group" }> | undefined {
  return items.find(
    (i): i is Extract<HistoryItem, { kind: "tool_group" }> => i.kind === "tool_group",
  );
}

describe("bossStore tool-call grouping", () => {
  it("coalesces consecutive same-name aggregatable tools into one live group", () => {
    initStore();
    bossStore.startTool("c1", "get_worker_status", { project: "api" });
    bossStore.startTool("c2", "get_worker_status", { project: "web" });

    const live = getBossState().liveItems;
    const g = group(live);
    expect(live.filter((i) => i.kind === "tool_group")).toHaveLength(1);
    expect(g?.tools.map((t) => t.toolCallId)).toEqual(["c1", "c2"]);
    // Grouped tools are not also tracked as standalone live tool_start rows.
    expect(live.some((i) => i.kind === "tool_start")).toBe(false);
  });

  it("marks grouped tools done in place without flushing the group mid-burst", () => {
    initStore();
    bossStore.startTool("c1", "get_worker_status", { project: "api" });
    bossStore.startTool("c2", "get_worker_status", { project: "web" });
    bossStore.endTool("c1", false, 5, "idle");
    bossStore.endTool("c2", false, 5, "working");

    const g = group(getBossState().liveItems);
    expect(g?.tools.map((t) => t.status)).toEqual(["done", "done"]);
    // Still live (not yet committed) — nothing closed it.
    expect(getBossState().pendingFlush).toHaveLength(0);
  });

  it("groups a prompt_worker dispatch burst into one row", () => {
    initStore();
    bossStore.startTool("c1", "prompt_worker", { project: "api", message: "go" });
    bossStore.startTool("c2", "prompt_worker", { project: "web", message: "go" });
    bossStore.startTool("c3", "prompt_worker", { project: "cli", message: "go" });

    const live = getBossState().liveItems;
    expect(live.filter((i) => i.kind === "tool_group")).toHaveLength(1);
    expect(group(live)?.tools.map((t) => t.args.project)).toEqual(["api", "web", "cli"]);
    expect(live.some((i) => i.kind === "tool_start")).toBe(false);
  });

  it("does not group state-changing tools (add_task stays individual)", () => {
    initStore();
    bossStore.startTool("c1", "add_task", { project: "api", title: "a" });
    bossStore.startTool("c2", "add_task", { project: "web", title: "b" });

    const live = getBossState().liveItems;
    expect(live.some((i) => i.kind === "tool_group")).toBe(false);
    expect(live.filter((i) => i.kind === "tool_start")).toHaveLength(2);
  });

  it("closes a done group when a different tool starts, flushing it to history", () => {
    initStore();
    bossStore.startTool("c1", "get_worker_status", { project: "api" });
    bossStore.endTool("c1", false, 5, "idle");
    // A different (non-aggregatable) tool starts → prior group is flushed.
    bossStore.startTool("c2", "cancel_worker", { project: "api" });

    const { liveItems, pendingFlush } = getBossState();
    expect(pendingFlush.some((i) => i.kind === "tool_group")).toBe(true);
    expect(liveItems.some((i) => i.kind === "tool_group")).toBe(false);
    expect(liveItems.some((i) => i.kind === "tool_start" && i.id === "c2")).toBe(true);
  });

  it("flushes a done group before committed assistant text to preserve order", () => {
    initStore();
    bossStore.startTool("c1", "list_workers", {});
    bossStore.endTool("c1", false, 5, "- api\n- web");
    bossStore.appendStreamText("Both workers are idle.");
    bossStore.flushPendingText();

    const ids = getBossState().pendingFlush.map((i) => i.kind);
    const groupAt = ids.indexOf("tool_group");
    const textAt = ids.indexOf("assistant");
    expect(groupAt).toBeGreaterThanOrEqual(0);
    expect(textAt).toBeGreaterThan(groupAt);
  });

  it("coalesces restored session history into groups like a live run", () => {
    initStore();
    const messages: Message[] = [
      { role: "user", content: "check workers" },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "r1", name: "get_worker_status", args: { project: "api" } },
          { type: "tool_call", id: "r2", name: "get_worker_status", args: { project: "web" } },
          { type: "tool_call", id: "r3", name: "add_task", args: { project: "api", title: "x" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "r1", content: "idle", isError: false },
          { type: "tool_result", toolCallId: "r2", content: "working", isError: false },
          { type: "tool_result", toolCallId: "r3", content: "added", isError: false },
        ],
      },
    ];
    bossStore.restoreHistory(messages);

    const history = getBossState().history;
    const restoredGroup = group(history);
    expect(restoredGroup?.tools.map((t) => t.args.project)).toEqual(["api", "web"]);
    // add_task is not aggregatable — stays an individual tool_done row.
    expect(history.some((i) => i.kind === "tool_done" && i.name === "add_task")).toBe(true);
  });

  it("starts a fresh group when an errored group breaks the run", () => {
    initStore();
    bossStore.startTool("c1", "get_worker_status", { project: "api" });
    bossStore.endTool("c1", true, 5, "boom");
    bossStore.startTool("c2", "get_worker_status", { project: "web" });

    // The errored group should not absorb the new call.
    const groups = getBossState().liveItems.filter((i) => i.kind === "tool_group");
    expect(groups).toHaveLength(1);
    expect((groups[0] as Extract<HistoryItem, { kind: "tool_group" }>).tools).toHaveLength(1);
  });
});
