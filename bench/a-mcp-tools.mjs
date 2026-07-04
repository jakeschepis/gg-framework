// Bench A — eager vs deferred MCP tool injection.
//
// Static:  measure the actual HTTP request payload (captured via custom fetch)
//          for the eager toolset vs a deferred `tool_search` stub.
// Live:    N-turn conversation per arm against gpt-5.5; per-turn input tokens,
//          cached tokens, cache-hit %, TTFT, total latency.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  stream,
  openaiCreds,
  MODEL,
  measuredTurn,
  freshCacheKey,
  mean,
  fmt,
  pct,
  table,
  sleep,
} from "./lib.mjs";

const req = createRequire(new URL("../packages/gg-ai/package.json", import.meta.url));
const { z } = await import(pathToFileURL(req.resolve("zod")).href);

const TURNS = 6;
const RUNS = 2;

// ── Assemble toolsets ──────────────────────────────────────
const { createTools } = await import("../packages/ggcoder/dist/tools/index.js");
const { MCPClientManager } = await import("../packages/ggcoder/dist/core/mcp/client.js");
const { getAllMcpServers } = await import("../packages/ggcoder/dist/core/mcp/defaults.js");

console.log("Connecting built-in tools + MCP servers…");
const { tools: builtinTools } = await createTools(process.cwd(), { lspDiagnostics: false });

const mcpManager = new MCPClientManager();
const servers = await getAllMcpServers("openai", undefined, process.cwd());
let mcpTools = [];
try {
  const results = await Promise.race([
    mcpManager.connectAllDetailed(servers),
    sleep(45_000).then(() => {
      throw new Error("MCP connect timeout");
    }),
  ]);
  for (const r of results) {
    if (r.tools) mcpTools.push(...r.tools);
    console.log(`  MCP ${r.name}: ${r.tools ? r.tools.length + " tools" : "FAILED: " + r.error}`);
  }
} catch (e) {
  console.log("  MCP connect issue:", e.message);
}

const toolSearchStub = {
  name: "tool_search",
  description:
    "Search the extended tool catalog (MCP servers and integrations) by capability. " +
    "Returns matching tool names + descriptions; matched tools become available next turn.",
  parameters: z.object({
    query: z.string().describe("What capability you need, e.g. 'search design screenshots'"),
  }),
};

const eagerTools = [...builtinTools, ...mcpTools];
const deferredTools = [...builtinTools, toolSearchStub];

// ── Static payload measurement (captured request body) ─────
async function capturePayload(tools) {
  const creds = await openaiCreds();
  let body = null;
  // The codex (OAuth) transport calls globalThis.fetch directly and ignores
  // options.fetch — intercept globally, capture the body, abort the request.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (urlOrReq, init) => {
    if (typeof init?.body === "string") body = init.body;
    else if (typeof Request !== "undefined" && urlOrReq instanceof Request)
      body = await urlOrReq.clone().text();
    throw new Error("__captured__");
  };
  try {
    const s = stream({
      provider: "openai",
      model: MODEL,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      messages: [{ role: "user", content: "hi" }],
      tools,
      maxTokens: 10,
    });
    for await (const _ of s) void _;
    await s;
  } catch {
    /* expected */
  } finally {
    globalThis.fetch = realFetch;
  }
  // The aborted capture stream's background pump can reject after we return;
  // swallow those so they don't crash the live-run phase.
  process.on("unhandledRejection", swallowCaptured);
  process.on("uncaughtException", swallowCaptured);
  if (!body) throw new Error("request body not captured");
  const parsed = JSON.parse(body);
  const toolsJson = JSON.stringify(parsed.tools ?? []);
  return { totalBytes: body.length, toolsBytes: toolsJson.length, toolCount: (parsed.tools ?? []).length };
}

function swallowCaptured(err) {
  if (err instanceof Error && err.message === "__captured__") return;
  throw err;
}

console.log("\n── Static payload (as sent on the wire) ──");
const eagerP = await capturePayload(eagerTools);
const deferredP = await capturePayload(deferredTools);
table(
  [
    ["eager (builtin+MCP)", eagerP.toolCount, eagerP.toolsBytes, Math.ceil(eagerP.toolsBytes / 4), eagerP.totalBytes],
    ["deferred (builtin+stub)", deferredP.toolCount, deferredP.toolsBytes, Math.ceil(deferredP.toolsBytes / 4), deferredP.totalBytes],
    [
      "delta",
      eagerP.toolCount - deferredP.toolCount,
      eagerP.toolsBytes - deferredP.toolsBytes,
      Math.ceil(Math.max(0, eagerP.toolsBytes - deferredP.toolsBytes) / 4),
      eagerP.totalBytes - deferredP.totalBytes,
    ],
  ],
  ["arm", "tools", "tools bytes", "~tokens", "req bytes"],
);

// ── Live multi-turn runs ───────────────────────────────────
const QUESTIONS = [
  "In one short sentence: what does a prompt prefix cache do?",
  "One short sentence: why do tool schemas count as input tokens?",
  "One short sentence: what is TTFT?",
  "One short sentence: name a tradeoff of deferred tool loading.",
  "One short sentence: what invalidates a prefix cache?",
  "Reply with exactly: done",
];
const SYSTEM =
  "You are a coding agent being benchmarked. Answer in ONE short sentence. Never call tools.";

async function runArm(name, tools) {
  const rows = [];
  for (let run = 0; run < RUNS; run++) {
    const cacheKey = freshCacheKey();
    const messages = [{ role: "system", content: SYSTEM }];
    for (let t = 0; t < TURNS; t++) {
      messages.push({ role: "user", content: QUESTIONS[t] });
      const r = await measuredTurn({ messages, tools, maxTokens: 60, promptCacheKey: cacheKey });
      messages.push({ role: "assistant", content: r.text || "(empty)" });
      rows.push({
        run,
        turn: t + 1,
        input: r.usage.inputTokens ?? 0,
        cached: r.usage.cacheRead ?? 0,
        ttft: r.ttftMs,
        total: r.totalMs,
      });
      await sleep(300);
    }
  }
  return { name, rows };
}

console.log("\n── Live runs (gpt-5.5, real OAuth) ──");
const arms = [];
arms.push(await runArm("eager", eagerTools));
arms.push(await runArm("deferred", deferredTools));

for (const arm of arms) {
  console.log(`\n[${arm.name}] per-turn:`);
  table(
    arm.rows.map((r) => [
      r.run + 1,
      r.turn,
      r.input,
      r.cached,
      fmt(pct(r.cached, r.input + r.cached), 1) + "%",
      r.ttft + "ms",
      r.total + "ms",
    ]),
    ["run", "turn", "input", "cached", "hit%", "ttft", "total"],
  );
}

console.log("\n── Summary (turns 2+, where cache can hit) ──");
table(
  arms.map((arm) => {
    const warm = arm.rows.filter((r) => r.turn > 1);
    const all = arm.rows;
    return [
      arm.name,
      fmt(mean(all.map((r) => r.input))),
      fmt(mean(warm.map((r) => r.cached))),
      fmt(mean(warm.map((r) => pct(r.cached, r.input + r.cached))), 1) + "%",
      fmt(mean(all.map((r) => r.ttft))) + "ms",
      fmt(all.reduce((a, r) => a + r.input, 0)),
    ];
  }),
  ["arm", "avg input tok", "avg cached (warm)", "avg hit% (warm)", "avg ttft", "total input tok"],
);

mcpManager.dispose?.();
process.exit(0);
