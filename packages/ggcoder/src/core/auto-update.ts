// The update engine now lives in @kenkaiiii/gg-core. This module pins it to
// ggcoder's npm package + state file, keeping the "ggcoder"-branded surface and
// the same exported function names so consumers/tests are unchanged.
import path from "node:path";
import os from "node:os";
import { createAutoUpdater } from "@kenkaiiii/gg-core";

const updater = createAutoUpdater({
  packageName: "@kenkaiiii/ggcoder",
  stateFilePath: () => path.join(os.homedir(), ".gg", "update-state.json"),
});

// Fork/dev builds (versioned like "4.10.2-plan-mode.dev") must NEVER auto-update.
// The engine's background `npm install -g @kenkaiiii/ggcoder@latest` would
// overwrite this locally-built fork with the vanilla published package and
// silently wipe the plan-mode feature. Detect the suffix and no-op the updater
// for those builds; published/release versions ("4.10.2") delegate unchanged.
function isForkBuild(version: string): boolean {
  return /-(plan-mode|dev)\b/.test(version);
}

export const checkAndAutoUpdate = (currentVersion: string): string | null =>
  isForkBuild(currentVersion) ? null : updater.checkAndAutoUpdate(currentVersion);

export const getPendingUpdate = (
  currentVersion: string,
): { latestVersion: string } | null =>
  isForkBuild(currentVersion) ? null : updater.getPendingUpdate(currentVersion);

export const startPeriodicUpdateCheck = (
  currentVersion: string,
  onUpdate: (message: string) => void,
): void => {
  if (isForkBuild(currentVersion)) return;
  updater.startPeriodicUpdateCheck(currentVersion, onUpdate);
};

export const stopPeriodicUpdateCheck = updater.stopPeriodicUpdateCheck;
