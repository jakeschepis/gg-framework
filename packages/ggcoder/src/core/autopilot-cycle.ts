/**
 * Autopilot cycle — the review→prompt→review loop as pure orchestration logic.
 *
 * The sidecar wires the real dependencies (kenAuto session, runAgent, SSE
 * broadcast); this module owns the loop's control flow so every exit path is
 * unit-testable without booting the sidecar.
 *
 * Two branches share one loop:
 *  - PLAN branch (planPending): GG Coder submitted a plan via exit_plan. Ken
 *    reviews the PLAN itself — approve (auto-accept + implement, then the next
 *    round work-reviews the implementation), send revision feedback, or hand a
 *    genuine user-level decision to the human. Verdict mapping for plans:
 *    `all_clear` ⇒ approve, and `ignore` ALSO maps to approve — "nothing to
 *    object to" on a plan means it's sound (autopilot has no user blocker for
 *    plans by design). Unparseable output still stops as HUMAN upstream (the
 *    verdict parser returns HUMAN for garbage) — never a blind loop.
 *  - WORK branch: the classic review of a finished turn (ALL_CLEAR / IGNORE /
 *    HUMAN / PROMPT), unchanged.
 *
 * A mid-cycle enter_plan WITHOUT exit_plan (isPlanMode() true, no pending
 * plan) still halts as HUMAN — Ken must never prompt into a read-only
 * plan-mode session.
 */
import type { AutopilotVerdict } from "./autopilot-verdict.js";

/** Reason shown in the Ken bubble when the build session is still INSIDE plan
 *  mode (enter_plan without exit_plan) when the cycle checks in — there is no
 *  submitted plan to review and the session is read-only, so the loop halts
 *  and hands control to the user. */
export const AUTOPILOT_PLAN_DRAFTING_REASON =
  "GG Coder is still drafting a plan (plan mode is active with nothing submitted). Finish or cancel the plan yourself; autopilot can't prompt a read-only session.";

/** Prompt injected into the build session when Ken rejects a plan with
 *  feedback. Mirrors the webview's manual "Feedback" wording in spirit: the
 *  plan was not approved, revise it, resubmit via exit_plan. */
export function buildPlanRevisionPrompt(feedback: string): string {
  return (
    `The plan was not approved. Feedback from Ken (automated reviewer):\n\n` +
    `${feedback}\n\n` +
    `Revise the plan based on this feedback, then call exit_plan again for review.`
  );
}

/** SSE frame types the cycle can emit (matched by the webview). */
export type AutopilotCycleEmit =
  | { type: "autopilot_done"; data: Record<string, never> }
  | { type: "autopilot_ignored"; data: Record<string, never> }
  | { type: "autopilot_human"; data: { reason: string } }
  | { type: "autopilot_capped"; data: { rounds: number } }
  | { type: "autopilot_plan_accepted"; data: Record<string, never> };

export interface AutopilotCycleDeps {
  /** Hard cap on review→prompt rounds per user turn (loop safety). The sidecar
   *  widens this by +2 when the cycle starts plan-pending (approve+implement
   *  and the post-implement review each consume a round). */
  maxRounds: number;
  /** True once /cancel fires — checked between every step. */
  isCancelled: () => boolean;
  /** Live plan-mode state of the BUILD session. */
  isPlanMode: () => boolean;
  /** True while a submitted plan (exit_plan) awaits a verdict. */
  planPending: () => boolean;
  /** Wipe the reviewer's history so each user turn starts cheap (within one
   *  cycle the review messages persist so Ken remembers what he asked). */
  resetReviewer: () => Promise<void>;
  /** Run one work review; resolves to the parsed verdict or null on failure
   *  (failure is already surfaced by the sidecar as autopilot_error). */
  review: () => Promise<AutopilotVerdict | null>;
  /** Run one PLAN review (plan digest, not work digest); null on failure OR
   *  when the review went stale (user acted mid-review) — both stop silently. */
  reviewPlan: () => Promise<AutopilotVerdict | null>;
  /** Auto-accept the pending plan (fresh session + approved-plan prompt).
   *  Resolves false when the plan generation went stale (a user Accept/Reject
   *  raced the review and won) — the cycle stops silently. */
  acceptPlan: () => Promise<boolean>;
  /** Run the "plan approved — implement it now" prompt on the fresh session. */
  runImplement: () => Promise<void>;
  /** Feed a PROMPT verdict's body to GG Coder as an injected run. */
  runPrompt: (body: string) => Promise<void>;
  /** Called BEFORE runPrompt: record the injected body (digest labeling) and
   *  broadcast the autopilot_prompted marker. */
  onInjected: (body: string, round: number) => void;
  /** Broadcast one of the cycle's terminal SSE frames. */
  emit: (event: AutopilotCycleEmit) => void;
}

/**
 * Drive one full autopilot cycle for a finished user turn. Every exit is
 * explicit:
 *  - cancelled                 → silent stop (the /cancel path already broadcast)
 *  - plan mode, no submission  → autopilot_human with the drafting reason
 *  - review failed (null)     → silent stop (autopilot_error already broadcast)
 *  - plan approve, stale accept→ silent stop (user's manual action won)
 *  - ALL_CLEAR                 → autopilot_done
 *  - IGNORE (work)             → autopilot_ignored (renders nothing)
 *  - HUMAN                     → autopilot_human
 *  - rounds exhausted          → autopilot_capped
 */
export async function driveAutopilotCycle(deps: AutopilotCycleDeps): Promise<void> {
  if (deps.isCancelled()) return;
  await deps.resetReviewer();
  for (let round = 1; round <= deps.maxRounds; round++) {
    if (deps.isCancelled()) return;
    if (deps.planPending()) {
      const verdict = await deps.reviewPlan();
      if (!verdict || deps.isCancelled()) return;
      if (verdict.kind === "human") {
        deps.emit({ type: "autopilot_human", data: { reason: verdict.reason } });
        return;
      }
      if (verdict.kind === "prompt") {
        // Rejection with feedback: inject a revision prompt. The sidecar's
        // acceptPlan-side state clears pendingPlanPath on injection; if the
        // run resubmits (exit_plan), planPending() is true again next round;
        // if not, the loop falls through to a normal work review of whatever
        // the run actually did.
        const body = buildPlanRevisionPrompt(verdict.body);
        deps.onInjected(body, round);
        await deps.runPrompt(body);
        continue;
      }
      // all_clear — and ignore mapped to approve ("nothing to object to" on a
      // plan means it's sound; plans never get a silent-ignore user blocker).
      const ok = await deps.acceptPlan();
      if (!ok) return; // generation went stale — the user's manual action won
      await deps.runImplement();
      // Next round: normal work review of the implementation.
      continue;
    }
    // The gate blocks a still-in-plan-mode turn up front, so hitting this
    // means an injected run entered plan mode mid-cycle WITHOUT submitting a
    // plan: halt — Ken can't prompt a read-only session.
    if (deps.isPlanMode()) {
      deps.emit({ type: "autopilot_human", data: { reason: AUTOPILOT_PLAN_DRAFTING_REASON } });
      return;
    }
    const verdict = await deps.review();
    if (!verdict || deps.isCancelled()) return;
    if (verdict.kind === "all_clear") {
      deps.emit({ type: "autopilot_done", data: {} });
      return;
    }
    if (verdict.kind === "ignore") {
      deps.emit({ type: "autopilot_ignored", data: {} });
      return;
    }
    if (verdict.kind === "human") {
      deps.emit({ type: "autopilot_human", data: { reason: verdict.reason } });
      return;
    }
    deps.onInjected(verdict.body, round);
    await deps.runPrompt(verdict.body);
    if (deps.isCancelled()) return;
  }
  deps.emit({ type: "autopilot_capped", data: { rounds: deps.maxRounds } });
}
