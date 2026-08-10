/**
 * Regression: a turn started by `sessionStore.pendingAction` must be reviewed
 * by autopilot.
 *
 * The gate used to live only inside `handleSubmit`, so every turn driven by the
 * post-remount pendingAction effect bypassed it — including the one that
 * matters most: after a plan is approved, `handleApprovePlan` remounts the tree
 * and hands `IMPLEMENT_PLAN_PROMPT` to the new mount. That turn writes all the
 * code and used to get zero autopilot review.
 *
 * The App is mounted for real; only the two seams it can't reach in a test are
 * faked — gg-agent's `agentLoop` (no provider call) and `useAutopilot` (no
 * reviewer session). Everything between them is the App's own wiring.
 */
import React from "react";
import { render } from "ink";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as ggAgent from "@kenkaiiii/gg-agent";
import { IMPLEMENT_PLAN_PROMPT } from "../core/autopilot-runtime.js";
import type * as useAutopilotModule from "./hooks/useAutopilot.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";

const seam = vi.hoisted(() => ({
  /** Assistant content the faked turn appends to the App's message array. */
  turnContent: [] as unknown[],
  /** How many times the agent actually ran — keeps "no review" non-vacuous. */
  turns: 0,
  /** Requests handed to autopilot's cycle — one entry per reviewed turn. */
  reviewed: [] as string[],
  enabled: true,
  active: false,
}));

vi.mock("@kenkaiiii/gg-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof ggAgent>();
  return {
    ...actual,
    // Real agentLoop mutates the messages array it is given; the gate reads
    // exactly that, so the fake has to do the same.
    agentLoop: (messages: Message[]) => {
      seam.turns += 1;
      messages.push({ role: "assistant", content: seam.turnContent } as Message);
      return (async function* () {})();
    },
  };
});

vi.mock("./hooks/useAutopilot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof useAutopilotModule>();
  return {
    ...actual,
    useAutopilot: () => ({
      enabled: seam.enabled,
      toggle: () => seam.enabled,
      setEnabled: () => seam.enabled,
      active: seam.active,
      isActive: () => seam.active,
      isEnabled: () => seam.enabled,
      runCycleAfterTurn: (originalRequest: string) => {
        seam.reviewed.push(originalRequest);
        return Promise.resolve();
      },
      cancel: () => {},
    }),
  };
});

const { App } = await import("./App.js");

/** Silent TTY-ish streams so Ink neither paints the suite nor trips over raw
 *  mode on a non-interactive stdin. */
function fakeStdout(): NodeJS.WriteStream {
  return {
    columns: 80,
    rows: 24,
    isTTY: true,
    writable: true,
    write(_chunk: string, callback?: (error?: Error | null) => void) {
      callback?.(null);
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream;
}

function fakeStdin(): NodeJS.ReadStream {
  return {
    isTTY: true,
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() {},
    read: () => null,
    on() {},
    off() {},
    removeListener() {},
    ref() {},
    unref() {},
  } as unknown as NodeJS.ReadStream;
}

/** The plan-approval hand-off: a fresh mount whose only job is to run the
 *  implementation prompt left behind in the session store. */
function mountWithPendingAction(prompt: string) {
  const sessionStore = {
    messages: [{ role: "system" as const, content: "system prompt" }] as Message[],
    history: [],
    planSteps: [],
    autopilotEnabled: true,
    pendingAction: { prompt, planEvent: { event: "approved" as const } },
  };
  return render(
    React.createElement(
      TerminalSizeProvider,
      null,
      React.createElement(App, {
        provider: "openai" as const,
        model: "gpt-5",
        tools: [],
        messages: sessionStore.messages,
        maxTokens: 4096,
        cwd: process.cwd(),
        version: "0.0.0-test",
        autopilotEnabled: true,
        sessionStore,
      }),
    ),
    {
      stdout: fakeStdout(),
      stdin: fakeStdin(),
      columns: 80,
      rows: 24,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the pendingAction turn to run, then give the gate room to decide. */
async function settle(): Promise<void> {
  const turnDeadline = Date.now() + 2000;
  while (seam.turns === 0 && Date.now() < turnDeadline) await sleep(10);
  const gateDeadline = Date.now() + 500;
  while (seam.reviewed.length === 0 && Date.now() < gateDeadline) await sleep(10);
}

describe("pendingAction turns and autopilot", () => {
  beforeEach(() => {
    seam.reviewed.length = 0;
    seam.turns = 0;
    seam.enabled = true;
    seam.active = false;
    // Reviewable work: an edit is not a mechanical tool call.
    seam.turnContent = [{ type: "tool_call", name: "edit", args: { file_path: "a.ts" } }];
  });

  it("reviews the plan-approval implementation turn", async () => {
    const app = mountWithPendingAction(IMPLEMENT_PLAN_PROMPT);
    await settle();
    app.unmount();

    expect(seam.turns).toBe(1);
    expect(seam.reviewed).toEqual([IMPLEMENT_PLAN_PROMPT]);
  });

  it("does not review when autopilot is off", async () => {
    seam.enabled = false;
    const app = mountWithPendingAction(IMPLEMENT_PLAN_PROMPT);
    await settle();
    app.unmount();

    expect(seam.turns).toBe(1);
    expect(seam.reviewed).toEqual([]);
  });

  it("skips a pendingAction turn whose tool calls were all mechanical", async () => {
    seam.turnContent = [{ type: "tool_call", name: "read", args: { file_path: "a.ts" } }];
    const app = mountWithPendingAction("re-run the task");
    await settle();
    app.unmount();

    expect(seam.turns).toBe(1);
    expect(seam.reviewed).toEqual([]);
  });
});
