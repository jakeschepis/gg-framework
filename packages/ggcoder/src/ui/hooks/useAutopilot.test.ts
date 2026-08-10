import React, { useEffect, useRef } from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import { AUTOPILOT_PLAN_DRAFTING_REASON } from "../../core/autopilot-cycle.js";
import { isWorkflowCommandText, shouldStartAutopilotCycle } from "../../core/autopilot-gate.js";
import { MAX_AUTOPILOT_ROUNDS, loadWorkflowCommandSpecs } from "../../core/autopilot-runtime.js";
import {
  useAutopilot,
  autopilotNoticeForEvent,
  type AutopilotNotice,
  type AutopilotReviewer,
  type UseAutopilotOptions,
  type UseAutopilotResult,
} from "./useAutopilot.js";

/** A reviewer whose replies are scripted verdict-by-verdict. */
function scriptedReviewer(
  replies: string[],
): AutopilotReviewer & { prompts: string[]; switches: string[] } {
  let next = 0;
  const messages: Message[] = [];
  return {
    prompts: [] as string[],
    switches: [] as string[],
    prompt(text: string) {
      this.prompts.push(text);
      messages.push({ role: "user", content: text });
      messages.push({ role: "assistant", content: replies[next++] ?? "ALL_CLEAR" });
      return Promise.resolve();
    },
    getMessages: () => messages,
    newSession: () => {
      messages.length = 0;
      return Promise.resolve();
    },
    dispose: () => Promise.resolve(),
    setSignal: () => {},
    switchModel(provider: string, model: string) {
      this.switches.push(`${provider}:${model}`);
      return Promise.resolve();
    },
  };
}

interface HarnessOptions {
  replies: string[];
  enabled?: boolean;
  planMode?: boolean;
  planModeAfterFirstRun?: boolean;
  runPrompt?: (framed: string) => Promise<void>;
  onReady?: (api: UseAutopilotResult) => void;
}

/** Mount the hook, run one cycle, and report everything it did. */
async function runHarness(opts: HarnessOptions): Promise<{
  notices: AutopilotNotice[];
  injected: string[];
  reviewer: ReturnType<typeof scriptedReviewer>;
}> {
  const notices: AutopilotNotice[] = [];
  const injected: string[] = [];
  const reviewer = scriptedReviewer(opts.replies);
  let planMode = opts.planMode ?? false;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  function Harness() {
    const providerRef = useRef<Provider>("anthropic");
    const modelRef = useRef("claude-sonnet-5");
    const gitBranchRef = useRef<string | null>("main");
    const messagesRef = useRef<Message[]>([
      { role: "user", content: "add a footer segment" },
      { role: "assistant", content: "done" },
    ]);
    const startedRef = useRef(false);
    const hookOptions: UseAutopilotOptions = {
      initialEnabled: opts.enabled ?? true,
      cwd: process.cwd(),
      gitBranchRef,
      providerRef,
      modelRef,
      messagesRef,
      isPlanMode: () => planMode,
      runPrompt: async (framed) => {
        injected.push(framed);
        if (opts.planModeAfterFirstRun) planMode = true;
        await opts.runPrompt?.(framed);
      },
      notify: (notice) => notices.push(notice),
      createReviewSession: () => Promise.resolve(reviewer),
    };
    const api = useAutopilot(hookOptions);

    useEffect(() => {
      if (startedRef.current) return;
      startedRef.current = true;
      opts.onReady?.(api);
      void api.runCycleAfterTurn("add a footer segment").then(done);
    }, [api]);

    return null;
  }

  const app = render(React.createElement(Harness), { patchConsole: false });
  await finished;
  app.unmount();
  return { notices, injected, reviewer };
}

/** Mount the hook and hand the API back so a test can drive cycle-by-cycle
 *  (and mutate the provider/model refs the host owns). */
function mountAutopilot(opts: {
  replies: string[];
  runPrompt?: (framed: string, api: UseAutopilotResult) => Promise<void>;
}): {
  ready: Promise<UseAutopilotResult>;
  reviewer: ReturnType<typeof scriptedReviewer>;
  providerRef: { current: Provider };
  modelRef: { current: string };
  unmount: () => void;
} {
  const reviewer = scriptedReviewer(opts.replies);
  const providerRef = { current: "anthropic" as Provider };
  const modelRef = { current: "claude-sonnet-5" };
  let resolveReady: (api: UseAutopilotResult) => void = () => {};
  const ready = new Promise<UseAutopilotResult>((resolve) => {
    resolveReady = resolve;
  });

  function Harness() {
    const gitBranchRef = useRef<string | null>("main");
    const messagesRef = useRef<Message[]>([
      { role: "user", content: "add a footer segment" },
      { role: "assistant", content: "done" },
    ]);
    const readyRef = useRef(false);
    const hookOptions: UseAutopilotOptions = {
      initialEnabled: true,
      cwd: process.cwd(),
      gitBranchRef,
      providerRef,
      modelRef,
      messagesRef,
      isPlanMode: () => false,
      runPrompt: async (framed) => {
        await opts.runPrompt?.(framed, api);
      },
      notify: () => {},
      createReviewSession: () => Promise.resolve(reviewer),
    };
    const api = useAutopilot(hookOptions);

    useEffect(() => {
      if (readyRef.current) return;
      readyRef.current = true;
      resolveReady(api);
    }, [api]);

    return null;
  }

  const app = render(React.createElement(Harness), { patchConsole: false });
  return { ready, reviewer, providerRef, modelRef, unmount: () => app.unmount() };
}

describe("autopilotNoticeForEvent", () => {
  it("renders nothing for IGNORE and a line for every other terminal state", () => {
    expect(autopilotNoticeForEvent({ type: "autopilot_ignored", data: {} })).toBeNull();
    expect(autopilotNoticeForEvent({ type: "autopilot_done", data: {} })?.tone).toBe("info");
    expect(
      autopilotNoticeForEvent({ type: "autopilot_human", data: { reason: "pick a colour" } })?.text,
    ).toContain("pick a colour");
    expect(autopilotNoticeForEvent({ type: "autopilot_capped", data: { rounds: 3 } })?.tone).toBe(
      "warning",
    );
  });
});

describe("autopilot gate as the TUI wires it", () => {
  const turn = {
    enabled: true,
    cancelled: false,
    planMode: false,
    planPending: false,
    workflowCommand: false,
    assistantMessagesAdded: 1,
    mechanicalOnly: false,
  };

  it("reviews an ordinary finished turn", () => {
    expect(shouldStartAutopilotCycle(turn)).toEqual({ start: true, kind: "work" });
  });

  it("skips a turn that ended inside plan mode", () => {
    expect(shouldStartAutopilotCycle({ ...turn, planMode: true })).toEqual({
      start: false,
      reason: "plan-mode",
    });
  });

  it("skips a workflow slash command, using the project's real command specs", async () => {
    const specs = await loadWorkflowCommandSpecs(process.cwd());
    expect(specs.length).toBeGreaterThan(0);
    const workflowCommand = isWorkflowCommandText(`/${specs[0].name}`, specs);

    expect(workflowCommand).toBe(true);
    expect(shouldStartAutopilotCycle({ ...turn, workflowCommand })).toEqual({
      start: false,
      reason: "workflow-command",
    });
  });

  it("skips a turn that produced no assistant output", () => {
    expect(shouldStartAutopilotCycle({ ...turn, assistantMessagesAdded: 0 })).toEqual({
      start: false,
      reason: "no-assistant-output",
    });
  });

  it("skips a turn the user interrupted", () => {
    expect(shouldStartAutopilotCycle({ ...turn, cancelled: true })).toEqual({
      start: false,
      reason: "cancelled",
    });
  });
});

describe("useAutopilot", () => {
  it("drives a PROMPT → ALL_CLEAR cycle and injects the framed fix prompt", async () => {
    const { notices, injected, reviewer } = await runHarness({
      replies: ["PROMPT\nThe footer width math is missing the new segment.", "ALL_CLEAR"],
    });

    expect(reviewer.prompts).toHaveLength(2);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("[Autopilot]");
    expect(injected[0]).toContain("The footer width math is missing the new segment.");
    expect(notices.at(-1)).toEqual({ text: "Autopilot: all clear.", tone: "info" });
  });

  it("stops at the round cap instead of looping forever", async () => {
    const { notices, injected } = await runHarness({
      replies: Array.from({ length: 10 }, (_, i) => `PROMPT\nkeep going ${i}`),
    });

    expect(injected).toHaveLength(MAX_AUTOPILOT_ROUNDS);
    expect(notices.at(-1)).toEqual({
      text: `Autopilot stopped after ${MAX_AUTOPILOT_ROUNDS} rounds — take it from here.`,
      tone: "warning",
    });
  });

  it("does nothing when autopilot is off", async () => {
    const { notices, reviewer } = await runHarness({
      replies: ["PROMPT\nfix it"],
      enabled: false,
    });

    expect(reviewer.prompts).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it("halts when an injected run enters plan mode without submitting a plan", async () => {
    const { notices, injected } = await runHarness({
      replies: ["PROMPT\nresearch this first", "ALL_CLEAR"],
      planModeAfterFirstRun: true,
    });

    expect(injected).toHaveLength(1);
    expect(notices.at(-1)).toEqual({
      text: `Autopilot needs you — ${AUTOPILOT_PLAN_DRAFTING_REASON}`,
      tone: "warning",
    });
  });

  it("stops mid-cycle when cancelled during an injected run", async () => {
    let api: UseAutopilotResult | undefined;
    const { notices, injected } = await runHarness({
      replies: ["PROMPT\nfirst fix", "PROMPT\nsecond fix"],
      onReady: (result) => {
        api = result;
      },
      runPrompt: async () => {
        api?.cancel();
      },
    });

    expect(injected).toHaveLength(1);
    // Cancellation is silent: the abort path already told the user.
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("Autopilot round 1");
  });

  it("re-points the cached reviewer when the model changes between cycles", async () => {
    const harness = mountAutopilot({ replies: ["ALL_CLEAR", "ALL_CLEAR"] });
    const api = await harness.ready;

    // No reviewer yet — nothing to switch, the first creation adopts the refs.
    await api.syncReviewerModel("openai", "gpt-5");
    expect(harness.reviewer.switches).toEqual([]);

    harness.providerRef.current = "anthropic";
    harness.modelRef.current = "claude-sonnet-5";
    await api.runCycleAfterTurn("add a footer segment");
    expect(harness.reviewer.prompts).toHaveLength(1);
    expect(harness.reviewer.switches).toEqual([]);

    // The user picks a different provider from the model overlay.
    harness.providerRef.current = "openai";
    harness.modelRef.current = "gpt-5";
    await api.syncReviewerModel("openai", "gpt-5");
    expect(harness.reviewer.switches).toEqual(["openai:gpt-5"]);

    // Re-selecting the same model is not a state change.
    await api.syncReviewerModel("openai", "gpt-5");
    expect(harness.reviewer.switches).toEqual(["openai:gpt-5"]);

    // The next review runs on the switched reviewer.
    await api.runCycleAfterTurn("and a header");
    expect(harness.reviewer.prompts).toHaveLength(2);
    harness.unmount();
  });

  it("defers a model switch that lands mid-cycle until the cycle finishes", async () => {
    const harness: ReturnType<typeof mountAutopilot> = mountAutopilot({
      replies: ["PROMPT\nthe footer width math is missing the new segment", "ALL_CLEAR"],
      runPrompt: async (_framed, api) => {
        await api.syncReviewerModel("openai", "gpt-5");
        // Mid-cycle: the reviewer must NOT be re-pointed under a live review.
        expect(api.isActive()).toBe(true);
        expect(harness.reviewer.switches).toEqual([]);
      },
    });
    const api = await harness.ready;

    await api.runCycleAfterTurn("add a footer segment");

    // Flushed once the cycle ended.
    expect(harness.reviewer.switches).toEqual(["openai:gpt-5"]);
    harness.unmount();
  });

  it("refuses to start a nested cycle while one is already running", async () => {
    let api: UseAutopilotResult | undefined;
    const nested = vi.fn();
    const { reviewer } = await runHarness({
      replies: ["PROMPT\nfix it", "ALL_CLEAR"],
      onReady: (result) => {
        api = result;
      },
      runPrompt: async () => {
        expect(api?.isActive()).toBe(true);
        // An injected run reaching handleSubmit must never re-enter.
        await api?.runCycleAfterTurn("nested").then(nested);
      },
    });

    expect(nested).toHaveBeenCalledTimes(1);
    // Still only the two reviews of the OUTER cycle — no nested review ran.
    expect(reviewer.prompts).toHaveLength(2);
  });
});
