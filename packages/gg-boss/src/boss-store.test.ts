import { describe, expect, it } from "vitest";
import { bossStore, getBossState } from "./boss-store.js";

describe("bossStore submitted user rows", () => {
  it("queues submitted users for durable history without also rendering them live", () => {
    bossStore.init({
      bossProvider: "anthropic",
      bossModel: "claude-test",
      workerProvider: "anthropic",
      workerModel: "claude-test",
      loggedInProviders: ["anthropic"],
      workers: [],
    });

    const userItem = bossStore.createUserItem("Run this");
    bossStore.queueSubmittedUserItem(userItem);

    let state = getBossState();
    expect(state.liveItems.some((item) => item.id === userItem.id)).toBe(false);
    expect(state.pendingFlush.map((item) => item.id)).toContain(userItem.id);

    bossStore.commitPendingFlush();

    state = getBossState();
    expect(state.pendingFlush).toHaveLength(0);
    expect(state.liveItems.some((item) => item.id === userItem.id)).toBe(false);
    expect(state.history.map((item) => item.id)).toContain(userItem.id);
  });
});
