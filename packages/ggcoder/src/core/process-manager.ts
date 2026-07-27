import type { spawnSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { killProcessTree } from "../utils/process.js";
import { getSafeToolEnv } from "../tools/safe-env.js";
import { resolveShell } from "./shell.js";
import type { AgentNotificationQueue } from "./agent-notifications.js";

export interface BackgroundProcess {
  id: string;
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
  exitCode: number | null;
  lastReadOffset: number;
}

export interface StartResult {
  id: string;
  pid: number;
  logFile: string;
}

export interface ReadOutputResult {
  id: string;
  isRunning: boolean;
  exitCode: number | null;
  output: string;
}

const BG_DIR = path.join(os.homedir(), ".gg", "bg");

/** How often a running process may report progress. */
const WATCH_INTERVAL_MS = 5_000;
/** Chars of log tail carried in a progress checkpoint. */
const CHECKPOINT_TAIL_CHARS = 320;

/** Last line(s) of the log, collapsed and bounded — never the raw log. */
function tailDigest(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length <= CHECKPOINT_TAIL_CHARS
    ? collapsed
    : `\u2026${collapsed.slice(collapsed.length - CHECKPOINT_TAIL_CHARS)}`;
}

function formatElapsed(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 6_000) / 10}m` : `${Math.round(ms / 1_000)}s`;
}

export interface ProcessManagerOps {
  platform?: NodeJS.Platform;
  kill?: typeof process.kill;
  killProcessTree?: (pid: number) => void;
  spawnSync?: typeof spawnSync;
  /**
   * Push queue for background-process progress checkpoints. When set, a long
   * build reports progress and its exit code into the agent's next turn
   * instead of waiting to be polled with `task_output`.
   */
  notifications?: AgentNotificationQueue;
}

function stopProcessTree(pid: number, ops: ProcessManagerOps = {}): void {
  if (ops.killProcessTree) {
    ops.killProcessTree(pid);
    return;
  }
  // killProcessTree is itself platform-aware (taskkill /T /F on Windows).
  killProcessTree(pid, { platform: ops.platform, kill: ops.kill, spawnSync: ops.spawnSync });
}

export class ProcessManager {
  private processes = new Map<string, BackgroundProcess>();
  private children = new Map<string, ChildProcess>();
  /** Per-process progress timers. Cleared on exit, stop and shutdown. */
  private watchers = new Map<string, ReturnType<typeof setInterval>>();
  /** Log size at the last emitted checkpoint, so a quiet process stays quiet. */
  private watchedSizes = new Map<string, number>();

  constructor(private readonly ops: ProcessManagerOps = {}) {}

  async start(command: string, cwd: string): Promise<StartResult> {
    await fsp.mkdir(BG_DIR, { recursive: true });

    const id = crypto.randomUUID().slice(0, 8);
    const logFile = path.join(BG_DIR, `${id}.log`);
    const fd = fs.openSync(logFile, "w");

    // Cross-platform shell (see core/shell.ts): bash on POSIX, Git Bash on
    // Windows, cmd.exe fallback. Same resolution as the foreground bash tool.
    const shell = resolveShell(command);
    const child = spawn(shell.file, shell.args, {
      cwd,
      detached: true,
      // stdin is a pipe so callers can drive interactive processes (REPLs,
      // scaffolders, [Y/n] prompts) via sendInput(); stdout/stderr go to the log.
      stdio: ["pipe", fd, fd],
      env: getSafeToolEnv(),
    });

    fs.closeSync(fd);

    // Swallow EPIPE: writing to a process that has already exited would
    // otherwise emit an unhandled 'error' and crash the host.
    child.stdin?.on("error", () => {});

    const pid = child.pid!;
    child.unref();

    const proc: BackgroundProcess = {
      id,
      pid,
      command,
      logFile,
      startedAt: Date.now(),
      exitCode: null,
      lastReadOffset: 0,
    };

    this.processes.set(id, proc);
    this.children.set(id, child);

    child.on("close", (code) => {
      proc.exitCode = code ?? 1;
      this.children.delete(id);
      this.disposeWatcher(id);
      this.notifyExit(proc);
    });

    this.armWatcher(proc);

    return { id, pid, logFile };
  }

  /**
   * Arm a debounced progress watcher for one background process. Emits at most
   * one latest-only checkpoint per interval, and only when the log actually
   * grew — so a 60s build reports itself without the agent ever calling
   * `task_output`, while an idle process stays silent.
   *
   * No-op when no notification queue is wired, so hosts that never drain
   * notifications pay nothing.
   */
  private armWatcher(proc: BackgroundProcess): void {
    const queue = this.ops.notifications;
    if (!queue) return;
    this.watchedSizes.set(proc.id, 0);
    const timer = setInterval(() => {
      // The process may have exited between ticks; the terminal checkpoint owns
      // that case and must not be overwritten by a stale progress line.
      if (proc.exitCode !== null) {
        this.disposeWatcher(proc.id);
        return;
      }
      void this.emitProgress(proc);
    }, WATCH_INTERVAL_MS);
    // Never hold the event loop open for a detached background process.
    timer.unref?.();
    this.watchers.set(proc.id, timer);
  }

  private async emitProgress(proc: BackgroundProcess): Promise<void> {
    const queue = this.ops.notifications;
    if (!queue) return;
    let size: number;
    try {
      size = (await fsp.stat(proc.logFile)).size;
    } catch {
      return;
    }
    const previous = this.watchedSizes.get(proc.id) ?? 0;
    if (size <= previous) return;
    this.watchedSizes.set(proc.id, size);
    if (proc.exitCode !== null) return;

    const tail = await this.readTail(proc.logFile, size);
    queue.enqueue(
      "process",
      proc.id,
      `Background process ${proc.id} (${proc.command}) is still running after ` +
        `${formatElapsed(Date.now() - proc.startedAt)}, ${size} bytes logged` +
        `${tail ? `. Latest: ${tail}` : ""}`,
    );
  }

  private notifyExit(proc: BackgroundProcess): void {
    const queue = this.ops.notifications;
    if (!queue) return;
    void (async () => {
      let size = 0;
      try {
        size = (await fsp.stat(proc.logFile)).size;
      } catch {
        // Log may already be gone; the exit code is still worth reporting.
      }
      const tail = size > 0 ? await this.readTail(proc.logFile, size) : "";
      queue.enqueue(
        "process",
        proc.id,
        `Background process ${proc.id} (${proc.command}) exited with code ${proc.exitCode} ` +
          `after ${formatElapsed(Date.now() - proc.startedAt)}` +
          `${tail ? `. Last output: ${tail}` : ""}. ` +
          `Read it with task_output id="${proc.id}".`,
        { terminal: true },
      );
    })();
  }

  /** Read the trailing bytes of a log without loading the whole file. */
  private async readTail(logFile: string, size: number): Promise<string> {
    const start = Math.max(0, size - CHECKPOINT_TAIL_CHARS * 4);
    try {
      const fh = await fsp.open(logFile, "r");
      try {
        const buf = Buffer.alloc(size - start);
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        return tailDigest(buf.subarray(0, bytesRead).toString("utf-8"));
      } finally {
        await fh.close();
      }
    } catch {
      return "";
    }
  }

  /** Stop and forget a process's watcher. A finished process keeps no timer. */
  private disposeWatcher(id: string): void {
    const timer = this.watchers.get(id);
    if (timer) clearInterval(timer);
    this.watchers.delete(id);
    this.watchedSizes.delete(id);
  }

  /** Live watcher ids. Exposed for leak assertions in tests. */
  activeWatchers(): string[] {
    return [...this.watchers.keys()];
  }

  async readOutput(id: string, fromStart?: boolean): Promise<ReadOutputResult> {
    const proc = this.processes.get(id);
    if (!proc) {
      return {
        id,
        isRunning: false,
        exitCode: null,
        output: `No background process with id "${id}"`,
      };
    }

    const offset = fromStart ? 0 : proc.lastReadOffset;
    let output = "";

    try {
      const stat = await fsp.stat(proc.logFile);
      if (stat.size > offset) {
        const buf = Buffer.alloc(stat.size - offset);
        const fh = await fsp.open(proc.logFile, "r");
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        await fh.close();
        output = buf.subarray(0, bytesRead).toString("utf-8");
        proc.lastReadOffset = offset + bytesRead;
      }
    } catch {
      output = "(failed to read log file)";
    }

    const isRunning = this.children.has(id);
    return { id, isRunning, exitCode: proc.exitCode, output };
  }

  /**
   * Write input to a running background process's stdin, enabling interactive
   * control (answer prompts, drive a REPL, feed a scaffolder). By default a
   * newline is appended (as if the user pressed Enter). Set `eof` to close
   * stdin afterwards, signalling end-of-input (Ctrl-D) to the program.
   */
  async sendInput(
    id: string,
    input: string,
    opts: { enter?: boolean; eof?: boolean } = {},
  ): Promise<string> {
    const proc = this.processes.get(id);
    if (!proc) return `No background process with id "${id}"`;

    const child = this.children.get(id);
    if (!child || proc.exitCode !== null) {
      return `Process ${id} already exited (code ${proc.exitCode})`;
    }

    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      return `Process ${id} is not accepting input (stdin is closed).`;
    }

    const enter = opts.enter ?? true;
    const text = input + (enter ? "\n" : "");

    try {
      if (text.length > 0) {
        await new Promise<void>((resolve, reject) => {
          stdin.write(text, (err) => (err ? reject(err) : resolve()));
        });
      }
      if (opts.eof) stdin.end();
    } catch (err) {
      return `Failed to send input to ${id}: ${(err as Error).message}`;
    }

    const summary = opts.eof
      ? text.length > 0
        ? `Sent input and closed stdin (EOF) for ${id}.`
        : `Closed stdin (EOF) for ${id}.`
      : `Sent input to ${id}.`;
    return `${summary} Use task_output with id="${id}" to read the response.`;
  }

  async stop(id: string): Promise<string> {
    const proc = this.processes.get(id);
    if (!proc) return `No background process with id "${id}"`;

    const child = this.children.get(id);
    if (!child || proc.exitCode !== null) {
      return `Process ${id} already exited (code ${proc.exitCode})`;
    }

    const isWindows = (this.ops.platform ?? process.platform) === "win32";
    if (isWindows) {
      // Windows has no process groups and no real SIGTERM: signalling the
      // wrapper only orphans its descendants. Force-kill the PID tree up front.
      stopProcessTree(proc.pid, this.ops);
    } else {
      // SIGTERM the group first so POSIX children get a chance to clean up.
      try {
        (this.ops.kill ?? process.kill)(-proc.pid, "SIGTERM");
      } catch {
        try {
          (this.ops.kill ?? process.kill)(proc.pid, "SIGTERM");
        } catch {
          return `Process ${id} already exited`;
        }
      }
    }

    // Wait up to 5s, then hard-kill a surviving tree.
    const exited = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      child.on("close", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });

    if (!exited) {
      if (isWindows) {
        return `Failed to stop process ${id}: it did not exit within 5 seconds and may still be running.`;
      }
      stopProcessTree(proc.pid, this.ops);
    }

    return `Process ${id} stopped`;
  }

  list(): BackgroundProcess[] {
    // Prune completed processes older than 5 minutes to prevent Map growth
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, proc] of this.processes) {
      if (proc.exitCode !== null && !this.children.has(id) && proc.startedAt < cutoff) {
        this.processes.delete(id);
        this.disposeWatcher(id);
      }
    }
    return Array.from(this.processes.values());
  }

  shutdownAll(): void {
    for (const [id, proc] of this.processes) {
      if (this.children.has(id)) {
        stopProcessTree(proc.pid, this.ops);
        proc.exitCode = proc.exitCode ?? 1;
        this.children.delete(id);
      }
      this.disposeWatcher(id);
    }
  }
}
