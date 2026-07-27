/**
 * A long background build must report itself. These tests drive real processes
 * (the watcher works off the on-disk log, so a fake would prove nothing) and
 * assert the two invariants that keep it cheap: bounded injected bytes, and no
 * timer outliving its process.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessManager } from "./process-manager.js";
import {
  AgentNotificationQueue,
  NOTIFICATION_MAX_CHARS,
  type AgentNotification,
} from "./agent-notifications.js";

const managers: ProcessManager[] = [];
const tempDirs: string[] = [];

function manager(notifications: AgentNotificationQueue): ProcessManager {
  const instance = new ProcessManager({ notifications });
  managers.push(instance);
  return instance;
}

async function tempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-process-notify-"));
  tempDirs.push(directory);
  return directory;
}

/** Poll the queue until a notification matching `predicate` is drained. */
async function waitForNotification(
  queue: AgentNotificationQueue,
  predicate: (entry: AgentNotification) => boolean,
  timeoutMs = 20_000,
): Promise<AgentNotification> {
  const deadline = Date.now() + timeoutMs;
  const seen: AgentNotification[] = [];
  while (Date.now() < deadline) {
    for (const entry of queue.drain()) {
      seen.push(entry);
      if (predicate(entry)) return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out. Saw: ${JSON.stringify(seen)}`);
}

afterEach(async () => {
  for (const instance of managers.splice(0)) instance.shutdownAll();
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("ProcessManager progress notifications", () => {
  it("pushes a terminal exit checkpoint without any task_output call", async () => {
    const queue = new AgentNotificationQueue();
    const instance = manager(queue);
    const cwd = await tempDir();

    const started = await instance.start("echo hello-from-build; exit 3", cwd);
    const exit = await waitForNotification(queue, (entry) => entry.terminal);

    expect(exit.kind).toBe("process");
    expect(exit.id).toBe(started.id);
    expect(exit.text).toContain("exited with code 3");
    expect(exit.text).toContain("hello-from-build");
    expect(exit.text).toContain("task_output");
    expect(exit.text.length).toBeLessThanOrEqual(NOTIFICATION_MAX_CHARS);
  }, 30_000);

  it("surfaces progress on a long-running process before it exits", async () => {
    const queue = new AgentNotificationQueue();
    const instance = manager(queue);
    const cwd = await tempDir();

    // Logs steadily for ~12s: long enough for at least one 5s checkpoint tick.
    const started = await instance.start(
      `for i in $(seq 1 12); do echo "step-$i"; sleep 1; done`,
      cwd,
    );
    const progress = await waitForNotification(queue, (entry) => !entry.terminal);

    expect(progress.id).toBe(started.id);
    expect(progress.text).toContain("still running");
    expect(progress.text).toContain("step-");
    expect(progress.text.length).toBeLessThanOrEqual(NOTIFICATION_MAX_CHARS);
    // Proven without a single task_output call.
    await instance.stop(started.id);
  }, 40_000);

  it("bounds the digest of a process that floods its log", async () => {
    const queue = new AgentNotificationQueue();
    const instance = manager(queue);
    const cwd = await tempDir();

    await instance.start(`for i in $(seq 1 2000); do echo "line-$i padding padding"; done`, cwd);
    const exit = await waitForNotification(queue, (entry) => entry.terminal);

    expect(exit.text.length).toBeLessThanOrEqual(NOTIFICATION_MAX_CHARS);
    // Digest is the TAIL, so the newest lines survive.
    expect(exit.text).toContain("line-2000");
  }, 30_000);

  it("leaves no watcher timer alive after a process exits", async () => {
    const queue = new AgentNotificationQueue();
    const instance = manager(queue);
    const cwd = await tempDir();

    const started = await instance.start("true", cwd);
    expect(instance.activeWatchers()).toContain(started.id);

    await waitForNotification(queue, (entry) => entry.terminal);
    expect(instance.activeWatchers()).toEqual([]);
  }, 30_000);

  it("disposes the watcher when a running process is stopped", async () => {
    const queue = new AgentNotificationQueue();
    const instance = manager(queue);
    const cwd = await tempDir();

    const started = await instance.start("sleep 30", cwd);
    expect(instance.activeWatchers()).toContain(started.id);

    await instance.stop(started.id);
    await waitForNotification(queue, (entry) => entry.terminal);
    expect(instance.activeWatchers()).toEqual([]);
  }, 30_000);

  it("stays silent when no notification queue is wired", async () => {
    const instance = new ProcessManager();
    managers.push(instance);
    const cwd = await tempDir();

    const started = await instance.start("echo quiet", cwd);
    expect(instance.activeWatchers()).toEqual([]);
    // The pull path still works exactly as before.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const read = await instance.readOutput(started.id);
    expect(read.output).toContain("quiet");
  }, 30_000);
});
