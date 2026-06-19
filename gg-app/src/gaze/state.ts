// Shared on/off state for the gaze feature, used by both the nav button (writer)
// and the GazeController (reader/owner). Persisted in localStorage so the choice
// survives reloads and new windows inherit it.
//
// Two sync paths because they cover different cases:
//   - a same-window `CustomEvent` (localStorage `storage` events do NOT fire in
//     the window that made the write — only in OTHER windows), and
//   - the native `storage` event for cross-window sync.

export const GAZE_ENABLED_KEY = "gg-app:gaze:enabled";
const SAME_WINDOW_EVENT = "gg-app:gaze:toggle";

/** Current enabled state from storage. */
export function isGazeEnabled(): boolean {
  return localStorage.getItem(GAZE_ENABLED_KEY) === "1";
}

/** Set enabled state, persist it, and notify this window + others. */
export function setGazeEnabled(on: boolean): void {
  localStorage.setItem(GAZE_ENABLED_KEY, on ? "1" : "0");
  window.dispatchEvent(new CustomEvent<boolean>(SAME_WINDOW_EVENT, { detail: on }));
}

/** Toggle and return the new state. */
export function toggleGazeEnabled(): boolean {
  const next = !isGazeEnabled();
  setGazeEnabled(next);
  return next;
}

/** Subscribe to enabled changes from any source (this window or another).
 *  Returns an unsubscribe fn. */
export function onGazeEnabledChange(cb: (on: boolean) => void): () => void {
  const onSame = (e: Event): void => cb((e as CustomEvent<boolean>).detail);
  const onStorage = (e: StorageEvent): void => {
    if (e.key === GAZE_ENABLED_KEY) cb(e.newValue === "1");
  };
  window.addEventListener(SAME_WINDOW_EVENT, onSame);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SAME_WINDOW_EVENT, onSame);
    window.removeEventListener("storage", onStorage);
  };
}
