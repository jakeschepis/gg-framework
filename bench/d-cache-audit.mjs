// Bench D — prefix-cache hit-rate audit with the REAL GG Coder system prompt.
//
// Arms:
//   control   — byte-stable prefix, pure message appends (our normal flow)
//   steering  — a wrapped mid-run steering user message appended at turn 4
//               (our real queued-prompt behavior; should NOT break the cache)
//   volatile  — a per-turn timestamp injected into the system prompt
//               (the classic cache-killing bug; shows what a regression looks like)
//
// Metrics per turn: input tokens, cached tokens, hit %, TTFT, latency.
import { measuredTurn, estTokens, freshCacheKey, mean, fmt, pct, table, sleep } from "./lib.mjs";

const TURNS = 6;
const RUNS = 2;

const { buildSystemPrompt } = await import("../packages/ggcoder/dist/system-prompt.js");
const { wrapSteeringText } = await import("../packages/ggcoder/dist/core/steering.js");

const baseSystem = await buildSystemPrompt(process.cwd());
console.log(`System prompt: ${baseSystem.length} chars (~${estTokens(baseSystem)} tokens)`);

const QUESTIONS = [
  "One short sentence: what is a prefix cache?",
  "One short sentence: what breaks it?",
  "One short sentence: how do providers report cache hits?",
  "One short sentence: what is a steering message?",
  "One short sentence: why does message order matter for caching?",
  "Reply with exactly: done",
];

async function runArm(name, { steerAtTurn, volatileSystem }) {
  const rows = [];
  for (let run = 0; run < RUNS; run++) {
    const cacheKey = freshCacheKey();
    const history = [];
    for (let t = 0; t < TURNS; t++) {
      if (steerAtTurn === t) {
        // Mirror the real mid-run steering drain: a wrapped user message
        // appended to history before the next model call.
        history.push({
          role: "user",
          content: wrapSteeringText("Also, keep every answer under 12 words."),
        });
      }
      history.push({ role: "user", content: QUESTIONS[t] });
      const system = volatileSystem
        ? `${baseSystem}\n\nCurrent time: ${new Date().toISOString()} (request #${t + 1})`
        : baseSystem;
      const messages = [{ role: "system", content: system }, ...history];
      const r = await measuredTurn({ messages, maxTokens: 60, promptCacheKey: cacheKey });
      history.push({ role: "assistant", content: r.text || "(empty)" });
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

const arms = [];
console.log("\nRunning control…");
arms.push(await runArm("control", {}));
console.log("Running steering…");
arms.push(await runArm("steering", { steerAtTurn: 3 }));
console.log("Running volatile-prefix…");
arms.push(await runArm("volatile", { volatileSystem: true }));

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

console.log("\n── Summary (turns 2+) ──");
table(
  arms.map((arm) => {
    const warm = arm.rows.filter((r) => r.turn > 1);
    return [
      arm.name,
      fmt(mean(warm.map((r) => pct(r.cached, r.input + r.cached))), 1) + "%",
      fmt(mean(warm.map((r) => r.ttft))) + "ms",
      fmt(warm.reduce((a, r) => a + r.input, 0)),
      fmt(arm.rows.reduce((a, r) => a + r.input, 0)),
    ];
  }),
  ["arm", "avg hit% (warm)", "avg ttft (warm)", "billed input tok (warm)", "total input tok"],
);
process.exit(0);
