# Bench Results — A/B/C/D (3 July 2026)

Live arms ran against **gpt-5.5 via real OAuth** (codex transport). Scripts in `bench/`,
Ink harness in `packages/ggcoder/.bench-render.mjs`. Note: gg-ai's OpenAI usage mapping
**subtracts** cached tokens from `inputTokens`, so `input` = billed uncached tokens.

## A — Eager vs deferred MCP tool injection  → WIN, implement

`bench/a-mcp-tools.mjs`. Eager = 15 builtin + 11 MCP tools (kencode-search + refero).
Deferred = builtin + one `tool_search` stub. 2 runs × 6 turns each arm.

Static (captured wire payload):

| arm | tools | tools bytes | ~tokens |
|---|---|---|---|
| eager | 26 | 47,638 | ~11,910 |
| deferred | 16 | 14,443 | ~3,611 |
| **delta** | | **−33,195 B** | **−8,299 tok/cold turn** |

Live (12 turns/arm):

| arm | total billed input tok | avg TTFT | cost per cache-miss turn |
|---|---|---|---|
| eager | 41,830 | 1,883ms | ~9,800 tok |
| deferred | 18,209 | 1,439ms | ~2,600 tok |

- **56% fewer billed input tokens**, **−24% TTFT**.
- Provider-side random full-misses happened in BOTH arms (~25% of turns) — with
  eager tools each miss re-bills the whole 9.7k prefix; deferred caps the blast
  radius at 3.8× less.
- Note: refero alone is ~8 tools of schema; every future MCP server makes eager worse.

## B — Streaming render flush interval (TUI)  → WIN, implement

`bench/b-render-cpu.mjs`. Real `AssistantMessage` + `TerminalSizeProvider` under Ink,
12s synthetic stream at ~800 chars/s, fresh process per arm.

| flush | CPU total | CPU % of core | renders | vs 16ms (current) |
|---|---|---|---|---|
| per-delta | 10,374ms | 86% | 455 | +26% |
| **16ms (current)** | 8,242ms | 69% | 448 | — |
| 50ms | 6,305ms | 53% | 236 | **−24%** |
| 100ms (Claude Code's pick) | 4,202ms | 35% | 120 | **−49%** |

- Matches Claude Code 2.1.191's reported ~37% cut.
- CPU scales with render count, not delta count — the Markdown re-render dominates.
- 100ms is imperceptible for streaming text; keep first-token immediate paint.
- gg-app webview uses rAF (~16ms) — same change applies to `useAgentEvents.flushChunks`.

## C — Partial output on mid-stream failure  → REAL GAP, implement

`bench/c-partial-loss.mjs`. Real `agentLoop` vs a local OpenAI-SSE mock that streams
750 chars then kills the socket; retry serves a distinguishable response.

| metric | value |
|---|---|
| partial preserved across retry | **NO — discarded, fully regenerated** |
| output chars paid twice | 750 (100% of pre-drop output) |
| wasted output tokens | ~188 per drop (scales with drop point — a drop at 10k chars wastes ~2.5k tok) |
| retry detection | 435ms (stream_stall) + 1,000ms backoff |

- The retry works (good), but everything streamed pre-drop is thrown away and
  re-billed at output-token prices. Claude Code 2.1.199 keeps the partial.
- Fix shape: on transport-failure retry, keep accumulated text/tool blocks as an
  assistant message + continuation instruction, instead of replaying the turn.

## D — Prefix-cache health + steering audit  → PASS, no bug; ship observability

`bench/d-cache-audit.mjs`. Real GG Coder system prompt (~7.9k tok). 3 arms × 2 runs × 6 turns.

| arm | warm hit% | avg TTFT (warm) | total billed input |
|---|---|---|---|
| control | 84.8% | 1,463ms | 29,279 |
| steering (wrapped msg at turn 4) | 94.1% | 1,615ms | 13,637 |
| volatile suffix (timestamp per turn) | 84.4% | 1,893ms | 29,677 |

- **Steering wrapper is cache-safe** — 93–95% hits immediately after injection.
  The OpenCode bug (steering reminder nuking prefix cache) does NOT exist here.
- **UNCACHED_MARKER date-suffix design validated**: even a per-turn timestamp at the
  END of the system prompt only cost the tail — prefix matching saved the rest.
- Residual issue is provider-side random full-misses (~1–2 per 6-turn run, both
  arms) — exactly why hit-rate observability in the UI is worth shipping.

## Verdict

| bench | verdict | expected gain |
|---|---|---|
| A deferred MCP tools | implement | −56% billed input tok, −24% TTFT (scales with MCP count) |
| B flush 100ms | implement | −49% streaming CPU (TUI); same fix for webview rAF batching |
| C partial preservation | implement | no re-billed output on transport retries; ~0.4–2.5k tok/drop |
| D steering/cache | no change needed | ship cache-hit% in ActivityBar (uses existing `cacheRead`) |

Reproduce: `node bench/a-mcp-tools.mjs` · `node bench/b-render-cpu.mjs` ·
`node bench/c-partial-loss.mjs` · `node bench/d-cache-audit.mjs` (from repo root).
