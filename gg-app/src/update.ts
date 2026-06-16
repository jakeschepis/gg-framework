import { useCallback, useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";

/**
 * App self-update, driven by the Tauri updater plugin (GitHub releases of this
 * repo — see `plugins.updater` in tauri.conf.json). One shared hook powers both
 * the footer banner and the home-screen button: it polls for an update on mount
 * + hourly, and `install()` downloads → installs → relaunches the app.
 */

export type UpdatePhase = "idle" | "checking" | "available" | "installing" | "error";

export interface UpdateInfo {
  /** The pending update (null until one is detected). */
  update: Update | null;
  /** Newer version string, e.g. "0.2.0" (null when up to date). */
  version: string | null;
  phase: UpdatePhase;
  /** Kick off download → install → relaunch. No-op unless an update is pending. */
  install: () => Promise<void>;
}

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * DEV ONLY — fake a pending update so the banner + home button + install flow
 * can be eyeballed before any real GitHub release exists. Flip to `false` (or
 * just ship a production build, where it's ignored) to disable. The simulated
 * install runs the phases without downloading or relaunching.
 */
const DEV_FAKE_UPDATE = false;
const devFakeEnabled = import.meta.env.DEV && DEV_FAKE_UPDATE;
const FAKE_VERSION = "9.9.9";

export function useAppUpdate(): UpdateInfo {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [fakeVersion, setFakeVersion] = useState<string | null>(null);

  const runCheck = useCallback(async (): Promise<void> => {
    if (devFakeEnabled) {
      setFakeVersion(FAKE_VERSION);
      setPhase((p) => (p === "installing" ? p : "available"));
      return;
    }
    // Don't interrupt an in-flight install with a re-check.
    setPhase((p) => (p === "installing" ? p : "checking"));
    try {
      const found = await check();
      if (found?.available) {
        setUpdate(found);
        setPhase((p) => (p === "installing" ? p : "available"));
        logInfo(`Update available: ${found.version}`);
      } else {
        setUpdate(null);
        setPhase((p) => (p === "installing" ? p : "idle"));
      }
    } catch (e) {
      // No endpoint / no release yet / offline — stay quiet, just no banner.
      setPhase((p) => (p === "installing" ? p : "idle"));
      logError(`Update check failed: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void runCheck();
    const id = setInterval(() => void runCheck(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runCheck]);

  const install = useCallback(async (): Promise<void> => {
    if (devFakeEnabled) {
      // Simulate download/install without touching disk or relaunching.
      setPhase("installing");
      logInfo("[dev] Simulating update install\u2026");
      await new Promise((r) => setTimeout(r, 2500));
      logInfo("[dev] Fake install done (no relaunch in dev).");
      return;
    }
    if (!update) return;
    setPhase("installing");
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setPhase("error");
      logError(`Update install failed: ${String(e)}`);
    }
  }, [update]);

  return {
    update,
    version: update?.version ?? fakeVersion,
    phase,
    install,
  };
}
