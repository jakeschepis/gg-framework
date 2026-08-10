import type { spawnSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { killProcessTree } from "../utils/process.js";
import { getSafeToolEnv } from "../tools/safe-env.js";
import { resolveShell, type ShellResolution } from "./shell.js";
import type { AgentNotificationQueue } from "./agent-notifications.js";

export interface BackgroundProcess {
  id: string;
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
  exitCode: number | null;
  lastReadOffset: number;
  /**
   * Last known size of `logFile` in bytes. Kept current by the progress
   * watcher, the exit handler and every `readOutput`, so consumers (notably
   * the pre-stop process gate) can tell "output was never consumed" from
   * "output was read" without an fs stat per check.
   */
  logSize: number;
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

/**
 * How long a background process log survives after its last write.
 *
 * Every `start()` opens a new `<id>.log` and nothing ever removed them, so the
 * directory grew without bound for the lifetime of the install — measured at
 * 14,358 files / 494MB on a single developer machine, with entries dating back
 * five months. These are debugging aids for a process the agent started; once
 * the run is long over, so is their value.
 */
const BG_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Throttle between prune sweeps, so a burst of `start()` calls scans once. */
const BG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Delay before a running process may first report progress. */
const WATCH_INTERVAL_MS = 5_000;
/** Ceiling on the progress interval as it backs off between reports. */
const WATCH_INTERVAL_MAX_MS = 120_000;
/**
 * How many progress checkpoints one background process may push, ever.
 *
 * A progress checkpoint is worth most early ("the build is underway", "it died
 * on startup") and approaches zero after that: a dev server the agent started
 * itself, still logging an hour on, tells it nothing it doesn't already know
 * and can always be inspected on demand with `task_output`.
 *
 * At a flat interval with no budget, such a server produced a fresh checkpoint
 * for essentially every loop step — measured here at ~2k tokens per minute of
 * overlap, i.e. a whole context window per hour spent restating "still
 * running".
 *
 * Anthropic reached the same conclusion the hard way: Claude Code shipped
 * periodic background status into the model's context as `task_progress` and
 * `background_task_status` attachments, then REMOVED both (they survive only in
 * a `LEGACY_ATTACHMENT_TYPES` list that drops them from resumed sessions).
 * Their progress is now a host-side stream event for the UI, and the only thing
 * pushed into context is the terminal completion notice.
 *
 * We keep a small early budget rather than going to zero: the first few reports
 * are what let the agent notice a build that died on startup without blocking
 * on it. Combined with the backoff those land at ~5s, ~15s and ~35s, after
 * which the watcher retires and only the exit notification remains.
 */
const WATCH_MAX_REPORTS = 3;
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
  /**
   * Directory for background process logs. Defaults to the real `~/.gg/bg`.
   *
   * Injectable because this manager both writes AND prunes here: a test that
   * calls `start()` without an override operates on the developer's own log
   * history. That is not hypothetical — running the suite once deleted ~12.7k
   * real logs off a machine before this parameter existed.
   */
  bgDir?: string;
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
  private watchers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Log size at the last emitted checkpoint, so a quiet process stays quiet. */
  private watchedSizes = new Map<string, number>();
  /** Timestamp of the last retention sweep; 0 means "never swept". */
  private lastPruneAt = 0;

  constructor(private readonly ops: ProcessManagerOps = {}) {}

  private get bgDir(): string {
    return this.ops.bgDir ?? BG_DIR;
  }

  /**
   * Delete background logs whose last write is older than the retention window.
   *
   * Deliberately best-effort and never awaited by `start()`: losing an old log
   * is harmless, but failing to launch the user's process because a stale log
   * couldn't be unlinked is not. Logs belonging to processes this manager still
   * tracks are skipped regardless of age — a quiet long-running dev server can
   * easily go a week without writing a line, and its log must stay readable.
   */
  private async pruneOldLogs(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneAt < BG_PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;

    let entries: string[];
    try {
      entries = await fsp.readdir(this.bgDir);
    } catch {
      return; // Directory missing or unreadable; nothing to prune.
    }

    const live = new Set([...this.processes.keys()].map((id) => `${id}.log`));
    const cutoff = now - BG_LOG_RETENTION_MS;
    for (const entry of entries) {
      if (!entry.endsWith(".log") || live.has(entry)) continue;
      const file = path.join(this.bgDir, entry);
      try {
        const stat = await fsp.stat(file);
        if (stat.mtimeMs >= cutoff) continue;
        await fsp.unlink(file);
      } catch {
        // Raced with another sweep or held open elsewhere; try again next time.
      }
    }
  }

  async start(command: string, cwd: string, launch?: ShellResolution): Promise<StartResult> {
    await fsp.mkdir(this.bgDir, { recursive: true });
    void this.pruneOldLogs();

    const id = crypto.randomUUID().slice(0, 8);
    const logFile = path.join(this.bgDir, `${id}.log`);
    const fd = fs.openSync(logFile, "w");

    // Cross-platform shell (see core/shell.ts): bash on POSIX, Git Bash on
    // Windows, cmd.exe fallback. Same resolution as the foreground bash tool.
    const shell = launch ?? resolveShell(command);
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
      logSize: 0,
    };

    this.processes.set(id, proc);
    this.children.set(id, child);

    child.on("close", (code) => {
      proc.exitCode = code ?? 1;
      this.children.delete(id);
      this.disposeWatcher(id);
      // Refresh unconditionally: the gate needs a final size even when no
      // notification queue is wired and notifyExit is a no-op.
      void this.refreshLogSize(proc).then(() => this.notifyExit(proc));
    });

    this.armWatcher(proc);

    return { id, pid, logFile };
  }

  /**
   * Arm a backing-off, budgeted progress watcher for one background process.
   * Emits at most one latest-only checkpoint per interval, only when the log
   * actually grew, and at most {@link WATCH_MAX_REPORTS} times in total — so a
   * build reports itself early without the agent ever calling `task_output`,
   * while an idle or long-lived process stops costing context.
   *
   * Once the budget is spent the watcher retires completely (no timer, no
   * further injections). The terminal exit notification is unaffected: it is
   * produced by the exit handler, not this watcher, so "it finished" always
   * still reaches the agent.
   *
   * Self-rescheduling rather than `setInterval` because the delay changes; a
   * tick is only scheduled once the previous one has been handled.
   *
   * No-op when no notification queue is wired, so hosts that never drain
   * notifications pay nothing.
   */
  private armWatcher(proc: BackgroundProcess): void {
    const queue = this.ops.notifications;
    if (!queue) return;
    this.watchedSizes.set(proc.id, 0);

    let delay = WATCH_INTERVAL_MS;
    let reports = 0;
    const schedule = (): void => {
      const timer = setTimeout(() => {
        // The process may have exited between ticks; the terminal checkpoint
        // owns that case and must not be overwritten by a stale progress line.
        if (proc.exitCode !== null) {
          this.disposeWatcher(proc.id);
          return;
        }
        void this.emitProgress(proc).then((emitted) => {
          // Re-check: the process can exit while the tail read is in flight,
          // and disposeWatcher may already have cleared this entry.
          if (proc.exitCode !== null || !this.watchers.has(proc.id)) return;
          if (emitted && ++reports >= WATCH_MAX_REPORTS) {
            // Budget spent: stop watching for good. `task_output` remains the
            // way to inspect this process, and its exit still notifies.
            this.disposeWatcher(proc.id);
            return;
          }
          // Back off only on an actual report. A process that goes quiet must
          // NOT drift towards the cap while emitting nothing — otherwise a dev
          // server that idles and then fails a recompile is heard about minutes
          // late. Silence is already free; only chattiness needs damping.
          if (emitted) delay = Math.min(delay * 2, WATCH_INTERVAL_MAX_MS);
          schedule();
        });
      }, delay);
      // Never hold the event loop open for a detached background process.
      timer.unref?.();
      this.watchers.set(proc.id, timer);
    };
    schedule();
  }

  /** Stat the log once and cache its size on the record. Returns 0 if unreadable. */
  private async refreshLogSize(proc: BackgroundProcess): Promise<number> {
    try {
      proc.logSize = (await fsp.stat(proc.logFile)).size;
    } catch {
      // Log may be gone (pruned, or never created); keep the last known size.
    }
    return proc.logSize;
  }

  /** Emit one progress checkpoint if the log grew. Returns whether it did. */
  private async emitProgress(proc: BackgroundProcess): Promise<boolean> {
    const queue = this.ops.notifications;
    if (!queue) return false;
    const size = await this.refreshLogSize(proc);
    const previous = this.watchedSizes.get(proc.id) ?? 0;
    if (size <= previous) return false;
    this.watchedSizes.set(proc.id, size);
    if (proc.exitCode !== null) return false;

    const tail = await this.readTail(proc.logFile, size);
    queue.enqueue(
      "process",
      proc.id,
      `Background process ${proc.id} (${proc.command}) is still running after ` +
        `${formatElapsed(Date.now() - proc.startedAt)}, ${size} bytes logged` +
        `${tail ? `. Latest: ${tail}` : ""}`,
    );
    return true;
  }

  private notifyExit(proc: BackgroundProcess): void {
    const queue = this.ops.notifications;
    if (!queue) return;
    void (async () => {
      const size = proc.logSize;
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
    if (timer) clearTimeout(timer);
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
      proc.logSize = stat.size;
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
