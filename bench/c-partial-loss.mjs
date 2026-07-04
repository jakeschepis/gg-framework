// Bench C — partial-output loss on mid-stream failure.
//
// A local OpenAI-compatible SSE server streams N chars of assistant text, then
// destroys the socket (simulated mid-stream 5xx/socket drop). The retry serves
// a full response. We run the REAL gg-agent agentLoop against it and measure:
//   - chars the user saw before the drop (streamed, then rolled back)
//   - chars preserved in the final assistant message (current behavior: 0)
//   - wasted tokens (partial output paid for, discarded, regenerated)
//   - added wall-clock latency from the retry
import http from "node:http";
import { estTokens, fmt, table } from "./lib.mjs";

const { agentLoop } = await import("../packages/gg-agent/dist/index.js");

const PARTIAL = "Here is the plan so far. ".repeat(30); // ~750 chars streamed pre-drop
// Retry response deliberately does NOT repeat the partial text — so if the
// final assistant message contains PARTIAL, the client preserved it; if it
// only contains RETRY_TEXT, the partial was discarded and regenerated.
const RETRY_TEXT = "Fresh regenerated answer from the retry attempt. ".repeat(28); // ~1400 chars
const FULL = RETRY_TEXT;

const CHUNK = 25;
const CHUNK_DELAY_MS = 12;

let requestCount = 0;
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  requestCount++;
  const isFirst = requestCount === 1;
  const text = isFirst ? PARTIAL : FULL;

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({
    id: "bench",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
  });
  for (let i = 0; i < text.length; i += CHUNK) {
    send({
      id: "bench",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: text.slice(i, i + CHUNK) } }],
    });
    await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
  }
  if (isFirst) {
    // Mid-stream transport failure: kill the socket without finish_reason.
    res.destroy();
    return;
  }
  send({
    id: "bench",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: estTokens(FULL) },
  });
  res.write("data: [DONE]\n\n");
  res.end();
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log(`Mock provider on :${port} — streams ${PARTIAL.length} chars then drops the socket.\n`);

const messages = [
  { role: "system", content: "bench" },
  { role: "user", content: "Give me the plan." },
];

const t0 = Date.now();
let streamedBeforeDrop = 0;
let retryAt = null;
let retryEvent = null;
let sawError = null;

const loop = agentLoop(messages, {
  provider: "openai",
  model: "bench-model",
  apiKey: "bench-key",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  tools: [],
});

for await (const ev of loop) {
  if (ev.type === "text_delta") {
    if (retryAt === null) streamedBeforeDrop += ev.text.length;
  } else if (ev.type === "retry") {
    if (retryAt === null) {
      retryAt = Date.now() - t0;
      retryEvent = ev;
    }
  } else if (ev.type === "error") {
    sawError = ev.error?.message;
  }
}
const totalMs = Date.now() - t0;

// Preservation may keep the partial as its own assistant message (followed by
// a continuation) — inspect ALL assistant text in the final history.
const finalText = messages
  .filter((m) => m.role === "assistant")
  .map((m) =>
    typeof m.content === "string"
      ? m.content
      : (m.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(""),
  )
  .join("\n");

const preserved = finalText.includes(PARTIAL.slice(0, 100)) ? PARTIAL.length : 0;
// Everything streamed before the drop that was thrown away and re-paid:
const regenerated = preserved > 0 ? 0 : streamedBeforeDrop;

console.log("── Results ──");
table(
  [
    ["chars streamed before drop (user saw)", streamedBeforeDrop],
    ["chars in final assistant message", finalText.length],
    ["partial preserved across retry", preserved > 0 ? "YES" : "NO — discarded, regenerated"],
    ["wasted output chars (paid twice)", regenerated],
    ["wasted output ~tokens", estTokens("x".repeat(regenerated))],
    ["retry fired at", retryAt !== null ? `${retryAt}ms (${retryEvent?.reason}, delay ${retryEvent?.delayMs}ms)` : "never"],
    ["total wall time", `${totalMs}ms`],
    [
      "est. wall time if partial were resumed",
      retryAt !== null
        ? `${fmt(totalMs - streamedBeforeDrop / CHUNK * CHUNK_DELAY_MS)}ms (skip re-streaming the partial)`
        : "n/a",
    ],
    ["error surfaced", sawError ?? "none"],
    ["provider requests made", requestCount],
  ],
  ["metric", "value"],
);

server.close();
process.exit(0);
