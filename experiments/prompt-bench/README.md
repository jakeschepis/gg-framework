# prompt-bench

Section-by-section ablation of the ggcoder system prompt. For each prompt
**section**, we test a `full` (production wording) variant against `compressed`
and `tiny` variants — keeping every other section at baseline — and measure
whether the **behavior** the section encodes survives the word cut.

The metric is not "same text". Agent output is non-deterministic, so we score
the **tool-call trajectory** (and final reply) against a behavioral rubric over
N iterations and compare pass-rates.

## Run

```bash
# from repo root, deps are workspace-linked
cd experiments/prompt-bench
../../node_modules/.bin/tsx run.ts --iterations 10 --section work --targets opus,gpt-5.5
```

Flags:
- `-n, --iterations <n>` — runs per cell (default 10). Use 10–15 for real signal.
- `-s, --section <key>` — `talk` or `work` (default: all).
- `-t, --targets <a,b>` — `opus`, `gpt-5.5` (default: both).

Auth comes from `~/.gg/auth.json` via the CLI's `AuthStorage` (OAuth refresh
included). If a provider 401s with "invalidated token", re-run `ggcoder login`
for that provider.

## How it works

- **`auth.ts`** — resolves OAuth creds (Opus + gpt-5.5) through `AuthStorage`.
- **`sandbox.ts`** — a jailed read/write/edit/ls/bash toolset rooted at a
  throwaway temp dir. Every call is recorded into a `trajectory`. Destructive
  commands can only damage the sandbox, never the real repo.
- **`variants.ts`** — `full` / `compressed` / `tiny` text per section. Keep
  `full` in sync with `packages/ggcoder/src/system-prompt.ts`.
- **`tasks.ts`** — seeded scenarios + binary rubric checks that read the
  trajectory (e.g. "did read precede the first edit?", "did it avoid `rm -rf`?").
- **`run.ts`** — drives the real `Agent` loop per (target × variant × task ×
  iteration) and prints pass-rate per check.

## Reading results

A compression is **safe** when its check pass-rates are statistically
indistinguishable from `full`. A drop on any guardrail check (e.g.
`did-not-nuke`, `reads-before-editing`) means those words were load-bearing —
keep them.

## Caveats

- **Trajectory ≠ intent.** We score what the model *did* with tools, not what
  it said it would do.
- **Tasks must trigger the behavior.** A guardrail you never exercise will read
  100% regardless of wording. When adding variants, add tasks that force the
  decision (and don't reveal the answer in the prompt, or read-before-edit
  becomes unnecessary).
- **Low N lies.** 1–2 iterations is a smoke test, not a result.
- **Anthropic OAuth** force-injects the "Claude Code" identity line regardless
  of the `identity` section — so that line isn't a compression candidate.
- This is a scratch experiment, excluded from the build/lint suite.
