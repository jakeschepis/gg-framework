/**
 * Autopilot for the terminal UI — Ken auto-reviews each finished turn and
 * injects fix prompts until the work comes back clear.
 *
 * The brain is shared with the gg-app sidecar and is NOT reimplemented here:
 *  - `driveAutopilotCycle` (core/autopilot-cycle.ts) owns the loop's control flow
 *  - `shouldStartAutopilotCycle` (core/autopilot-gate.ts) owns "review this turn?"
 *  - `parseAutopilotVerdict` (core/autopilot-verdict.ts) owns verdict parsing
 *  - `buildKenAutopilotContext` / `buildKenAutopilotPlanContext` build the digest
 *  - `KEN_ALLOWED_TOOLS` / `MAX_AUTOPILOT_ROUNDS` (core/autopilot-runtime.ts)
 *
 * Only the *host* wiring differs: the sidecar drives one `AgentSession`, while
 * the TUI drives `useAgentLoop` with history in `messagesRef`. The reviewer
 * itself is still a transient, read-only `AgentSession` created lazily on the
 * first cycle — it never writes, never persists, and never shares the user's
 * session store.
 *
 * One deliberate divergence: this hook does NOT own the plan-approve →
 * implement handoff. The TUI's approve path (`handleApprovePlan` in App.tsx)
 * remounts the whole tree and drives the implementation turn through
 * `sessionStore.pendingAction`, so a cycle cannot survive across it — the
 * host's `acceptPlan` always resolves false and the remounted app reviews the
 * implementation turn on its own. The cycle's `runImplement` dependency is
 * therefore wired to a no-op here (the sidecar, which CAN continue in-process,
 * supplies the real one). This hook is React-bound by construction, so the
 * sidecar's wiring can never move onto it; `core/autopilot-cycle.ts` is the
 * shared seam for both hosts.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../../core/agent-session.js";
import { log } from "../../core/logger.js";
import {
  driveAutopilotCycle,
  frameAutopilotInjection,
  type AutopilotCycleEmit,
} from "../../core/autopilot-cycle.js";
import {
  KEN_ALLOWED_MCP_SERVERS,
  KEN_ALLOWED_TOOLS,
  MAX_AUTOPILOT_ROUNDS,
  lastAssistantText,
  loadWorkflowCommandSpecs,
} from "../../core/autopilot-runtime.js";
import { parseAutopilotVerdict, type AutopilotVerdict } from "../../core/autopilot-verdict.js";
import { buildKenAutopilotContext, buildKenAutopilotPlanContext } from "../../core/ken-context.js";
import { buildKenAutopilotSystemPrompt } from "../../core/ken-prompt.js";

/** Tone of an autopilot notice, mapped to an info item by the host. */
export type AutopilotNoticeTone = "info" | "warning";

export interface AutopilotNotice {
  text: string;
  tone: AutopilotNoticeTone;
}

/** Render one cycle event as the line the user sees in the transcript.
 *  Returns null for events that render nothing (IGNORE is deliberately silent —
 *  Ken decided there was nothing worth saying). */
export function autopilotNoticeForEvent(event: AutopilotCycleEmit): AutopilotNotice | null {
  switch (event.type) {
    case "autopilot_done":
      return { text: "Autopilot: all clear.", tone: "info" };
    case "autopilot_ignored":
      return null;
    case "autopilot_human":
      return { text: `Autopilot needs you — ${event.data.reason}`, tone: "warning" };
    case "autopilot_capped":
      return {
        text: `Autopilot stopped after ${event.data.rounds} rounds — take it from here.`,
        tone: "warning",
      };
    case "autopilot_plan_accepted":
      return { text: "Autopilot: plan approved — implementing.", tone: "info" };
  }
}

/** Host surface the hook drives. Everything the cycle needs from the TUI that
 *  isn't shared core, kept narrow so the hook is testable without React state. */
export interface UseAutopilotOptions {
  /** Persisted starting state (settings + session store). */
  initialEnabled: boolean;
  cwd: string;
  /** Current git branch, for the review digest's project header. */
  gitBranchRef: MutableRefObject<string | null>;
  /** Provider/model the reviewer adopts — Ken follows GG Coder's model. */
  providerRef: MutableRefObject<Provider>;
  modelRef: MutableRefObject<string>;
  /** The build conversation the digest is distilled from. */
  messagesRef: MutableRefObject<Message[]>;
  /** Live plan-mode state of the TUI. */
  isPlanMode: () => boolean;
  /** Feed an autopilot-injected prompt to the agent loop. The hook frames it
   *  with the autopilot preamble before handing it over. */
  runPrompt: (framedPrompt: string) => Promise<void>;
  /** Show one line in the transcript. */
  notify: (notice: AutopilotNotice) => void;
  /** Called whenever the toggle flips, for persistence. */
  onEnabledChange?: (enabled: boolean) => void;
  /** Path of a plan submitted this turn and still awaiting a verdict, or null. */
  pendingPlanPath?: () => string | null;
  /** Read a submitted plan's markdown (defaults to reading the file). */
  readPlan?: (planPath: string) => Promise<string>;
  /** Approve the pending plan.
   *
   *  Contract for this hook's hosts: resolve **false**. False means "the cycle
   *  ends here" — either the approval went stale (a manual Accept/Reject won)
   *  or the host took over the implementation itself. The TUI does the latter:
   *  approving remounts the tree and runs the implementation turn via
   *  `sessionStore.pendingAction`, and the remounted app reviews that turn.
   *
   *  Resolving true asks the cycle to continue into an implement turn that this
   *  hook does not own (see the module header) — it is wired to a no-op, so a
   *  true here logs an error and implements nothing. */
  acceptPlan?: (planPath: string) => Promise<boolean>;
  /** Test seam: build the reviewer session. */
  createReviewSession?: (opts: {
    provider: Provider;
    model: string;
    cwd: string;
    signal: AbortSignal;
  }) => Promise<AutopilotReviewer>;
}

/** The subset of AgentSession the reviewer needs — narrowed so tests can
 *  substitute a fake without constructing a real session. */
export interface AutopilotReviewer {
  prompt: (text: string) => Promise<unknown>;
  getMessages: () => Message[];
  newSession: () => Promise<unknown>;
  dispose: () => Promise<void>;
  setSignal: (signal: AbortSignal) => void;
  /** Re-point an already-created reviewer at a new provider/model — the
   *  reviewer is cached for the process lifetime, so a `/model` switch has to
   *  reach it or every later review keeps calling the original provider. */
  switchModel: (provider: string, model: string) => Promise<void>;
}

export interface UseAutopilotResult {
  /** Footer/UI state. */
  enabled: boolean;
  /** Flip the toggle (Ctrl+A). Returns the new state. */
  toggle: () => boolean;
  /** Set the toggle explicitly (`/autopilot on|off`). Returns the new state. */
  setEnabled: (next: boolean) => boolean;
  /** True while a cycle is running (a review or an injected run). */
  active: boolean;
  /** Synchronous re-entrancy guard — an injected run must never start a nested
   *  cycle, and React state lags a tick behind. */
  isActive: () => boolean;
  /** Read the toggle synchronously (gate checks run outside render). */
  isEnabled: () => boolean;
  /** Drive one full cycle for a just-finished turn. */
  runCycleAfterTurn: (originalRequest: string) => Promise<void>;
  /** Cancel an in-flight cycle (Esc / Ctrl+C). */
  cancel: () => void;
  /** Follow the user's `/model` switch. Safe to call at any time: no-op before
   *  the reviewer exists (it adopts the live refs when created) and deferred
   *  until the current cycle finishes if one is running. */
  syncReviewerModel: (provider: Provider, model: string) => Promise<void>;
}

async function createDefaultReviewer(opts: {
  provider: Provider;
  model: string;
  cwd: string;
  signal: AbortSignal;
}): Promise<AutopilotReviewer> {
  const session = new AgentSession({
    provider: opts.provider,
    model: opts.model,
    cwd: opts.cwd,
    systemPrompt: await buildKenAutopilotSystemPrompt(opts.cwd),
    allowedTools: KEN_ALLOWED_TOOLS,
    allowedMcpServers: KEN_ALLOWED_MCP_SERVERS,
    transient: true,
    signal: opts.signal,
    // Review rounds routinely span the injected run (often minutes).
    forceLongCacheRetention: true,
  });
  // Ken IS the reviewer here — running his own ideal self-review adds latency
  // and can corrupt the verdict shape.
  session.setIdealReviewSuppressed(true);
  await session.initialize();
  return session;
}

export function useAutopilot(options: UseAutopilotOptions): UseAutopilotResult {
  const [enabled, setEnabledState] = useState(options.initialEnabled);
  const [active, setActive] = useState(false);
  const enabledRef = useRef(enabled);
  const activeRef = useRef(false);
  const cancelledRef = useRef(false);
  const reviewerRef = useRef<AutopilotReviewer | null>(null);
  const reviewerAbortRef = useRef<AbortController>(new AbortController());
  // Provider/model the cached reviewer is currently pointed at, and a model
  // switch that landed mid-cycle and has to wait for it to finish.
  const reviewerModelRef = useRef<{ provider: Provider; model: string } | null>(null);
  const pendingReviewerModelRef = useRef<{ provider: Provider; model: string } | null>(null);
  // Bodies autopilot injected into the build conversation. The digest labels
  // matching user messages as Ken's own prompts instead of user asks.
  const injectedPromptsRef = useRef<string[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  enabledRef.current = enabled;

  useEffect(() => {
    return () => {
      reviewerAbortRef.current.abort();
      void reviewerRef.current?.dispose().catch(() => {});
      reviewerRef.current = null;
    };
  }, []);

  const setEnabled = useCallback((next: boolean): boolean => {
    setEnabledState(next);
    enabledRef.current = next;
    optionsRef.current.onEnabledChange?.(next);
    log("INFO", "autopilot", next ? "Autopilot enabled" : "Autopilot disabled");
    return next;
  }, []);

  const toggle = useCallback(() => setEnabled(!enabledRef.current), [setEnabled]);

  const cancel = useCallback(() => {
    if (!activeRef.current) return;
    cancelledRef.current = true;
    reviewerAbortRef.current.abort();
  }, []);

  const ensureReviewer = useCallback(async (): Promise<AutopilotReviewer> => {
    if (reviewerRef.current) return reviewerRef.current;
    const opts = optionsRef.current;
    const create = opts.createReviewSession ?? createDefaultReviewer;
    const reviewer = await create({
      provider: opts.providerRef.current,
      model: opts.modelRef.current,
      cwd: opts.cwd,
      signal: reviewerAbortRef.current.signal,
    });
    reviewerRef.current = reviewer;
    reviewerModelRef.current = { provider: opts.providerRef.current, model: opts.modelRef.current };
    return reviewer;
  }, []);

  /** Mirror of the sidecar's `syncKenAutoModel`: keep the cached reviewer on
   *  the model the user actually selected. */
  const syncReviewerModel = useCallback(
    async (provider: Provider, model: string): Promise<void> => {
      // Not created yet — the next `ensureReviewer` reads the live refs, which
      // the host already updated.
      if (!reviewerRef.current) return;
      // Never re-point a session mid-review; `runCycleAfterTurn` flushes this.
      if (activeRef.current) {
        pendingReviewerModelRef.current = { provider, model };
        return;
      }
      pendingReviewerModelRef.current = null;
      const current = reviewerModelRef.current;
      if (current && current.provider === provider && current.model === model) return;
      try {
        await reviewerRef.current.switchModel(provider, model);
        reviewerModelRef.current = { provider, model };
        log("INFO", "autopilot", "autopilot reviewer model synced", { provider, model });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("ERROR", "autopilot", "autopilot reviewer model sync failed", { message });
      }
    },
    [],
  );

  /** One review round: build the digest, prompt the reviewer, parse the verdict.
   *  Returns null on failure so the cycle stops instead of looping blind. */
  const runReview = useCallback(
    async (originalRequest: string, planPath: string | null): Promise<AutopilotVerdict | null> => {
      const opts = optionsRef.current;
      try {
        const reviewer = await ensureReviewer();
        const base = {
          cwd: opts.cwd,
          gitBranch: opts.gitBranchRef.current,
          messages: opts.messagesRef.current,
          originalRequest,
          injectedPrompts: [...injectedPromptsRef.current],
          workflowCommands: await loadWorkflowCommandSpecs(opts.cwd),
        };
        let digest: string;
        if (planPath) {
          const readPlan =
            opts.readPlan ??
            (async (p: string) =>
              (await import("node:fs/promises")).readFile(p, "utf-8") as Promise<string>);
          const planContent = await readPlan(planPath).catch(() => "");
          if (!planContent.trim()) return null;
          digest = buildKenAutopilotPlanContext({ ...base, planContent });
        } else {
          digest = buildKenAutopilotContext(base);
        }
        await reviewer.prompt(digest);
        if (cancelledRef.current) return null;
        return parseAutopilotVerdict(lastAssistantText(reviewer.getMessages()));
      } catch (err) {
        if (cancelledRef.current) return null;
        const message = err instanceof Error ? err.message : String(err);
        log("ERROR", "autopilot", "autopilot review failed", { message });
        opts.notify({ text: `Autopilot review failed — ${message}`, tone: "warning" });
        return null;
      }
    },
    [ensureReviewer],
  );

  const runCycleAfterTurn = useCallback(
    async (originalRequest: string): Promise<void> => {
      if (!enabledRef.current || activeRef.current) return;
      activeRef.current = true;
      cancelledRef.current = false;
      // A cancelled previous cycle leaves an aborted controller behind; the
      // reviewer needs a live signal for this one.
      if (reviewerAbortRef.current.signal.aborted) {
        reviewerAbortRef.current = new AbortController();
        reviewerRef.current?.setSignal(reviewerAbortRef.current.signal);
      }
      setActive(true);
      const opts = optionsRef.current;
      // The plan path is captured per round: a revision injection clears it,
      // and a resubmitted plan sets it again.
      const planPathNow = () => opts.pendingPlanPath?.() ?? null;
      const startedPlanPending = planPathNow() !== null;
      let planPathAtReview: string | null = null;
      try {
        await driveAutopilotCycle({
          // A plan-pending cycle needs extra rounds: approve+implement and the
          // post-implement work review each consume one.
          maxRounds: startedPlanPending ? MAX_AUTOPILOT_ROUNDS + 2 : MAX_AUTOPILOT_ROUNDS,
          isCancelled: () => cancelledRef.current,
          isPlanMode: () => opts.isPlanMode(),
          planPending: () => planPathNow() !== null,
          resetReviewer: async () => {
            injectedPromptsRef.current = [];
            await reviewerRef.current?.newSession().catch(() => {});
          },
          review: () => runReview(originalRequest, null),
          reviewPlan: async () => {
            planPathAtReview = planPathNow();
            if (!planPathAtReview) return null;
            return runReview(originalRequest, planPathAtReview);
          },
          acceptPlan: async () => {
            const planPath = planPathAtReview;
            // The user's own Accept/Reject racing the review always wins.
            if (!planPath || planPathNow() !== planPath) return false;
            if (!opts.acceptPlan) return false;
            const accepted = await opts.acceptPlan(planPath).catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              log("ERROR", "autopilot", "autopilot plan accept failed", { message });
              opts.notify({ text: `Autopilot plan approval failed — ${message}`, tone: "warning" });
              return false;
            });
            return accepted;
          },
          // The shared cycle requires this dep, but no host of THIS hook can
          // reach it: acceptPlan always resolves false (the TUI remounts on
          // approve and drives the implement turn itself). Reaching it means a
          // host broke that contract — say so loudly instead of silently
          // work-reviewing a plan that was never implemented.
          runImplement: async () => {
            log(
              "ERROR",
              "autopilot",
              "autopilot runImplement reached in the TUI host — acceptPlan must resolve false " +
                "(the implement turn is driven by App.tsx handleApprovePlan, not this hook)",
            );
          },
          onInjected: (body, round) => {
            // Record the FRAMED string — that's what actually lands in the
            // conversation, so the digest matches it and labels it as Ken's.
            injectedPromptsRef.current.push(frameAutopilotInjection(body));
            log("INFO", "autopilot", "autopilot injected a prompt", { round: String(round) });
            opts.notify({ text: `Autopilot round ${round} — ${body}`, tone: "info" });
          },
          runPrompt: async (body) => {
            await opts.runPrompt(frameAutopilotInjection(body));
          },
          emit: (event) => {
            const notice = autopilotNoticeForEvent(event);
            if (notice) opts.notify(notice);
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("ERROR", "autopilot", "autopilot cycle failed", { message });
        if (!cancelledRef.current) {
          opts.notify({ text: `Autopilot stopped — ${message}`, tone: "warning" });
        }
      } finally {
        activeRef.current = false;
        setActive(false);
        // Apply any model switch that landed mid-cycle.
        const pending = pendingReviewerModelRef.current;
        pendingReviewerModelRef.current = null;
        if (pending) await syncReviewerModel(pending.provider, pending.model);
      }
    },
    [runReview, syncReviewerModel],
  );

  return {
    enabled,
    toggle,
    setEnabled,
    active,
    isActive: useCallback(() => activeRef.current, []),
    isEnabled: useCallback(() => enabledRef.current, []),
    runCycleAfterTurn,
    cancel,
    syncReviewerModel,
  };
}
