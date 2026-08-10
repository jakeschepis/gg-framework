/**
 * The single source of truth for the post-approval implementation prompt.
 *
 * This module is deliberately a **zero-import leaf**: no Node builtins, no
 * sibling modules, no types. It is imported by both runtimes —
 *
 *   - Node   → `autopilot-runtime.ts` re-exports it for `app-sidecar.ts` and
 *              the terminal `ui/App.tsx`.
 *   - Browser → `gg-app/src/App.tsx` imports it directly (relative source
 *              import; gg-app does not depend on the `@kenkaiiii/ggcoder`
 *              package, and its webview bundle must stay free of Node code).
 *
 * `autopilot-runtime.ts` cannot be imported from the webview: it pulls in
 * `custom-commands.js`, which imports `node:fs/promises` and `node:path`. Keep
 * this file free of imports so both bundles can share the literal.
 */

/** The prompt fed to the fresh session after a plan is approved. Every approval
 *  path — the gg-app webview's manual Accept, the TUI's Accept, and autopilot's
 *  auto-approve in both hosts — sends exactly this, so auto- and manual approval
 *  produce identical implementation turns. */
export const IMPLEMENT_PLAN_PROMPT =
  "The plan has been approved. Implement it now, following each step in order.";
