import { describe, expect, it } from "vitest";
import type { Message, ToolResult } from "@kenkaiiii/gg-ai";
import { repairToolPairingAdjacent } from "./agent-loop.js";

function assistantCall(...ids: string[]): Message {
  return {
    role: "assistant",
    content: ids.map((id) => ({ type: "tool_call" as const, id, name: "bash", args: {} })),
  };
}

function toolResults(...ids: string[]): Message {
  return {
    role: "tool",
    content: ids.map((id) => ({
      type: "tool_result" as const,
      toolCallId: id,
      content: `output ${id}`,
    })),
  };
}

function resultIds(msg: Message | undefined): string[] {
  if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) return [];
  return (msg.content as ToolResult[]).map((r) => r.toolCallId);
}

describe("repairToolPairingAdjacent", () => {
  it("fills a missing result with an interrupted marker", () => {
    const messages: Message[] = [assistantCall("a", "b"), toolResults("a")];

    repairToolPairingAdjacent(messages);

    expect(resultIds(messages[1])).toEqual(["a", "b"]);
    const filled = (messages[1]!.content as ToolResult[])[1]!;
    expect(filled.isError).toBe(true);
    expect(filled.content).toBe("Tool execution was interrupted.");
  });

  it("inserts a tool message when none follows the tool_call", () => {
    const messages: Message[] = [assistantCall("a"), { role: "user", content: "next" }];

    repairToolPairingAdjacent(messages);

    expect(messages).toHaveLength(3);
    expect(resultIds(messages[1])).toEqual(["a"]);
    expect(messages[2]!.role).toBe("user");
  });

  it("drops a late duplicate result appended after the turn moved on", () => {
    // Exact shape of a wedged session: a bash call is interrupted and closed out
    // with a synthetic result, the user prompts again, new tools run, and only
    // then does the original bash result land in its own trailing tool message.
    const messages: Message[] = [
      assistantCall("interrupted-bash"),
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "interrupted-bash",
            content: "Tool execution was interrupted.",
            isError: true,
          },
        ],
      },
      { role: "user", content: "go" },
      assistantCall("search-1", "search-2"),
      toolResults("search-1", "search-2"),
      toolResults("interrupted-bash"),
    ];

    repairToolPairingAdjacent(messages);

    expect(messages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
    ]);
    expect(resultIds(messages[4])).toEqual(["search-1", "search-2"]);
    // Every remaining result pairs with the immediately preceding assistant.
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role !== "tool") continue;
      const prev = messages[i - 1]!;
      expect(prev.role).toBe("assistant");
      const callIds = (prev.content as { type: string; id?: string }[])
        .filter((p) => p.type === "tool_call")
        .map((p) => p.id);
      for (const id of resultIds(messages[i])) expect(callIds).toContain(id);
    }
  });

  it("drops a duplicate result for a call already answered", () => {
    // Same wedge, tightest form: the late result lands directly after the
    // synthetic one, so merging makes both adjacent and only the dedup set can
    // tell them apart. The first (already-sent) answer wins.
    const messages: Message[] = [
      assistantCall("a"),
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "a",
            content: "Tool execution was interrupted.",
            isError: true,
          },
        ],
      },
      toolResults("a"),
    ];

    repairToolPairingAdjacent(messages);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(resultIds(messages[1])).toEqual(["a"]);
    expect((messages[1]!.content as ToolResult[])[0]!.content).toBe(
      "Tool execution was interrupted.",
    );
  });

  it("keeps a split result set by merging consecutive tool messages", () => {
    const messages: Message[] = [
      assistantCall("a", "b"),
      toolResults("a"),
      toolResults("b"),
      { role: "user", content: "next" },
    ];

    repairToolPairingAdjacent(messages);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(resultIds(messages[1])).toEqual(["a", "b"]);
    const kept = (messages[1]!.content as ToolResult[]).map((r) => r.content);
    expect(kept).toEqual(["output a", "output b"]);
  });

  it("removes a tool message whose assistant was dropped by compaction", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      toolResults("vanished"),
      { role: "assistant", content: "done" },
    ];

    repairToolPairingAdjacent(messages);

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
