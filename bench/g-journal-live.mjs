// Bench H — LIVE end-to-end test of the project journal against real credentials.
//
// Unit tests prove the file format. They cannot answer the questions that
// actually matter: does an entry get created during a real conversation, what
// does a real compactor actually write, does a LATER session receive it, and
// does the model use it? This drives a real AgentSession end to end.
//
// Phase 1: real conversation in a scratch project, then force compaction.
// Phase 2: inspect .gg/memory.md — what was actually written.
// Phase 3: a NEW session in the same project; check the journal reaches the
//          prompt, then ask a question only the journal can answer.
//
// Run from repo root: node bench/g-journal-live.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { AgentSession } = await import("../packages/ggcoder/dist/core/agent-session.js");
const { JOURNAL_RELATIVE_PATH } = await import("../packages/ggcoder/dist/core/memory/journal.js");

const PROVIDER = process.env.GG_BENCH_PROVIDER ?? "anthropic";
const MODEL = process.env.GG_BENCH_MODEL ?? "claude-sonnet-5";

// Enable the setting for this run only, restoring whatever was there before.
const settingsPath = path.join(os.homedir(), ".gg", "settings.json");
const originalSettings = fs.existsSync(settingsPath)
  ? fs.readFileSync(settingsPath, "utf-8")
  : null;

function setMemoryEnabled(enabled) {
  const current = originalSettings ? JSON.parse(originalSettings) : {};
  fs.writeFileSync(settingsPath, JSON.stringify({ ...current, memoryEnabled: enabled }, null, 2));
}

function restoreSettings() {
  if (originalSettings === null) fs.rmSync(settingsPath, { force: true });
  else fs.writeFileSync(settingsPath, originalSettings);
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gg-journal-live-"));
let session;

function banner(title) {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

async function newSession() {
  const s = new AgentSession({
    provider: PROVIDER,
    model: MODEL,
    cwd,
    maxTurns: 6,
    selfCorrectionHooks: false,
  });
  await s.initialize();
  return s;
}

/** Run one real user turn to completion, returning the assistant's text. */
async function ask(s, prompt) {
  let text = "";
  s.eventBus.on("text_delta", (d) => {
    text += d.text ?? "";
  });
  await s.prompt(prompt);
  return text.trim();
}

try {
  setMemoryEnabled(true);

  // Give the scratch project a real file so the work is genuine.
  await fsp.mkdir(path.join(cwd, "src"), { recursive: true });
  await fsp.writeFile(
    path.join(cwd, "src", "slugify.ts"),
    "export function slugify(input: string): string {\n  return input.toLowerCase();\n}\n",
    "utf-8",
  );

  banner("PHASE 1 — real conversation, then force compaction");
  session = await newSession();
  console.log(`project: ${cwd}`);
  console.log(`model:   ${PROVIDER}/${MODEL}\n`);

  // Compaction keeps ~8K tokens of RECENT history verbatim and only summarizes
  // what is older than that, so a small conversation has nothing to compact.
  // Real long sessions get there by reading files; do the same rather than
  // faking the transcript.
  for (const name of ["parser", "router", "cache", "queue"]) {
    const body = Array.from(
      { length: 220 },
      (_, i) =>
        `export function ${name}Helper${i}(input: string): string {\n` +
        `  // Step ${i}: normalise the incoming value before dispatching it onward.\n` +
        `  return input.trim().concat("${name}-${i}");\n}\n`,
    ).join("\n");
    await fsp.writeFile(path.join(cwd, "src", `${name}.ts`), body, "utf-8");
  }

  const turns = [
    "Read src/slugify.ts, then edit it so the function also replaces spaces with hyphens. " +
      "Keep it to that one change.",
    "Read src/parser.ts and tell me in one sentence what those helpers have in common.",
    "Read src/router.ts and tell me in one sentence what those helpers have in common.",
    "Read src/cache.ts and tell me in one sentence what those helpers have in common.",
    "Read src/queue.ts and tell me in one sentence what those helpers have in common.",
  ];
  for (const [i, turn] of turns.entries()) {
    const answer = await ask(session, turn);
    console.log(`turn ${i + 1}: ${answer.slice(0, 140).replace(/\s+/g, " ")}`);
  }
  console.log(`\nestimated transcript tokens: ~${Math.round(
    JSON.stringify(session.getMessages()).length / 4,
  )}`);

  session.eventBus.on("compaction_end", (payload) => {
    console.log(`\ncompaction_end: ${JSON.stringify(payload)}`);
  });
  console.log(`\nmessages before compaction: ${session.getMessages().length}`);
  await session.compact();
  console.log(`messages after compaction:  ${session.getMessages().length}`);

  banner("PHASE 2 — what actually landed in .gg/memory.md");
  const journalPath = path.join(cwd, JOURNAL_RELATIVE_PATH);
  if (!fs.existsSync(journalPath)) {
    console.log("!! NO JOURNAL FILE WAS CREATED — the feature did not fire.");
  } else {
    console.log(fs.readFileSync(journalPath, "utf-8"));
  }
  await session.dispose();
  session = undefined;

  banner("PHASE 3 — a NEW session: does it receive and use the journal?");
  session = await newSession();
  const systemPrompt = String(session.getMessages()[0]?.content ?? "");
  const marker = "<!-- uncached -->";
  const inPrompt = systemPrompt.includes("## Project memory");
  const afterMarker =
    systemPrompt.indexOf("## Project memory") > systemPrompt.indexOf(marker) &&
    systemPrompt.includes(marker);
  console.log(`journal present in system prompt: ${inPrompt ? "YES" : "NO"}`);
  console.log(`placed in the UNCACHED tail:      ${afterMarker ? "YES" : "NO"}`);
  if (inPrompt) {
    const section = systemPrompt.slice(systemPrompt.indexOf("## Project memory"));
    console.log(`\n--- journal section as the model sees it ---\n${section.slice(0, 900)}`);
  }

  // A question a cold session cannot answer from the code alone: the code shows
  // WHAT it does now, not what a previous session was asked to do.
  const answer2 = await ask(
    session,
    "Without reading any files: according to your project memory, what was a previous " +
      "session asked to do in this project? Answer in one sentence, or say you don't know.",
  );
  console.log(`\n--- new session's answer ---\n${answer2.slice(0, 500)}`);

  banner("RESULT");
  const used = /hyphen|space|slug/i.test(answer2);
  console.log(`journal file created:        ${fs.existsSync(journalPath) ? "YES" : "NO"}`);
  console.log(`journal reached new session: ${inPrompt ? "YES" : "NO"}`);
  console.log(`new session used it:         ${used ? "YES" : "NO / unclear"}`);
} finally {
  if (session) await session.dispose().catch(() => {});
  restoreSettings();
  console.log(`\nscratch project left at: ${cwd}`);
}
