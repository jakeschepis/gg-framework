// Bench B — TUI streaming render CPU vs flush interval.
// Spawns the Ink harness (inside packages/ggcoder so deps resolve) once per
// arm in a fresh process. Arms: 0ms (per-delta), 16ms (current), 50ms, 100ms
// (Claude Code 2.1.191's choice).
import { spawn } from "node:child_process";
import { table } from "./lib.mjs";

const DURATION_MS = 12_000;
const ARMS = [0, 16, 50, 100];

function runArm(flushMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [".bench-render.mjs", String(flushMs), String(DURATION_MS)],
      { cwd: "packages/ggcoder", stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => {
      const line = out.trim().split("\n").pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`arm ${flushMs}ms failed (code ${code}): ${err.slice(0, 500)}`));
      }
    });
  });
}

const results = [];
for (const flushMs of ARMS) {
  console.log(`Running arm: flush=${flushMs === 0 ? "per-delta" : flushMs + "ms"}…`);
  results.push(await runArm(flushMs));
}

console.log(`\n── Streaming render CPU (${DURATION_MS / 1000}s synthetic stream, ~800 chars/s) ──`);
const base = results.find((r) => r.flushMs === 16);
table(
  results.map((r) => [
    r.flushMs === 0 ? "per-delta" : `${r.flushMs}ms${r.flushMs === 16 ? " (current)" : ""}`,
    `${r.cpuUserMs + r.cpuSysMs}ms`,
    `${r.cpuPct}%`,
    r.renders,
    r.flushes,
    r.inkWrites,
    `${(r.bytesWritten / 1024).toFixed(0)}KB`,
    base
      ? `${((((r.cpuUserMs + r.cpuSysMs) - (base.cpuUserMs + base.cpuSysMs)) / (base.cpuUserMs + base.cpuSysMs)) * 100).toFixed(0)}%`
      : "-",
  ]),
  ["flush", "cpu total", "cpu%", "renders", "flushes", "ink writes", "tty bytes", "vs 16ms"],
);
process.exit(0);
