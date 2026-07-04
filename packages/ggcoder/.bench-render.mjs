// Bench B harness — Ink streaming render CPU at a given flush interval.
// Usage: node .bench-render.mjs <flushMs> <durationMs>
// Placed inside packages/ggcoder so `ink`/`react` resolve to the real deps.
// Prints one JSON line with metrics.
import React from "react";
import { render, Box } from "ink";
import { Writable } from "node:stream";
import { AssistantMessage } from "./dist/ui/components/AssistantMessage.js";
import { TerminalSizeProvider } from "./dist/ui/hooks/useTerminalSize.js";

const FLUSH_MS = Number(process.argv[2] ?? 16);
const DURATION_MS = Number(process.argv[3] ?? 12_000);
const DELTA_MS = 25; // one delta every 25ms
const DELTA_CHARS = 20; // ~800 chars/sec stream

// Realistic markdown-ish assistant output.
const CORPUS =
  "## Plan\n\nHere is what I will do next:\n\n" +
  "- Read the `agent-loop.ts` file and **trace** the retry path\n" +
  "- Update `session.ts` to persist partial output\n\n" +
  "```ts\nconst x = await stream(options);\nfor await (const ev of x) {\n  handle(ev);\n}\n```\n\n" +
  "This keeps the transcript stable while streaming continues. ";

let writes = 0;
let bytesWritten = 0;
const sink = new Writable({
  write(chunk, _enc, cb) {
    writes++;
    bytesWritten += chunk.length;
    cb();
  },
});
sink.columns = 100;
sink.rows = 40;
sink.isTTY = true;

let renders = 0;
function Harness({ getText, tick }) {
  renders++;
  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(AssistantMessage, { text: getText(), streaming: true }),
  );
}

let text = "";
let pending = "";
let setTick = null;

function Root() {
  const [tick, set] = React.useState(0);
  setTick = set;
  return React.createElement(
    TerminalSizeProvider,
    null,
    React.createElement(Harness, { getText: () => text, tick }),
  );
}

const instance = render(React.createElement(Root), {
  stdout: sink,
  stderr: sink,
  stdin: process.stdin,
  patchConsole: false,
  exitOnCtrlC: false,
});

// Deltas accumulate into `pending`; flusher moves them into `text` + re-renders.
let flushes = 0;
const deltaTimer = setInterval(() => {
  let i = Math.floor(Math.random() * (CORPUS.length - DELTA_CHARS));
  pending += CORPUS.slice(i, i + DELTA_CHARS);
  if (FLUSH_MS === 0) doFlush(); // per-delta rendering (no coalescing)
}, DELTA_MS);

function doFlush() {
  if (!pending) return;
  text += pending;
  pending = "";
  flushes++;
  setTick?.((t) => t + 1);
}

const flushTimer = FLUSH_MS > 0 ? setInterval(doFlush, FLUSH_MS) : null;

const cpu0 = process.cpuUsage();
const t0 = Date.now();

setTimeout(() => {
  clearInterval(deltaTimer);
  if (flushTimer) clearInterval(flushTimer);
  doFlush();
  const cpu = process.cpuUsage(cpu0);
  const wallMs = Date.now() - t0;
  instance.unmount();
  console.log(
    JSON.stringify({
      flushMs: FLUSH_MS,
      wallMs,
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSysMs: Math.round(cpu.system / 1000),
      cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 100),
      renders,
      flushes,
      inkWrites: writes,
      bytesWritten,
      finalChars: text.length,
    }),
  );
  process.exit(0);
}, DURATION_MS);
