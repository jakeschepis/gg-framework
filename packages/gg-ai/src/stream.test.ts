import { describe, expect, it } from "vitest";
import { localWireModelId, stream } from "./stream.js";
import { GGAIError } from "./errors.js";

describe("localWireModelId", () => {
  it("strips the endpoint routing prefix so the server sees its own id", () => {
    expect(localWireModelId("local/ollama/qwen3-coder:30b")).toBe("qwen3-coder:30b");
    // Raw ids can contain slashes (vLLM serves HF repo ids).
    expect(localWireModelId("local/vllm/Qwen/Qwen3-32B")).toBe("Qwen/Qwen3-32B");
  });

  it("leaves non-local ids untouched", () => {
    expect(localWireModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(localWireModelId("qwen/qwen3.6-plus")).toBe("qwen/qwen3.6-plus");
  });
});

describe("local provider", () => {
  it("refuses to stream without an endpoint instead of guessing a port", () => {
    expect(() =>
      stream({
        provider: "local",
        model: "local/ollama/qwen3-coder:30b",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "local",
      }),
    ).toThrow(GGAIError);
  });
});
