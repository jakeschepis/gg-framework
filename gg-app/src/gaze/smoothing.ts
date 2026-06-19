// Pure smoothing + dwell logic for gaze focus — no DOM, no Tauri, fully unit
// testable. The controller wires these to a tracker and the Rust bridge.

/** Exponential-moving-average smoother for the 2D gaze point. Raw webcam gaze
 *  is jittery; without this the highlight flickers between windows on every
 *  saccade. `factor` is the weight of the newest sample (0..1). */
export function createPointSmoother(factor: number) {
  let x: number | null = null;
  let y: number | null = null;
  const a = Math.min(1, Math.max(0, factor));
  return {
    push(nx: number, ny: number): { nx: number; ny: number } {
      x = x == null ? nx : x + a * (nx - x);
      y = y == null ? ny : y + a * (ny - y);
      return { nx: x, ny: y };
    },
    reset(): void {
      x = null;
      y = null;
    },
  };
}

/** Tracks how long the gaze has rested on one window and decides when to commit
 *  keyboard focus. Returns `commit: true` exactly once per crossing, after the
 *  candidate window has been stable for `dwellMs` AND differs from the last
 *  committed window — so a brief glance never steals focus, and re-committing
 *  the already-focused window is suppressed. The dwell requirement doubles as
 *  hysteresis against rapid back-and-forth switching. */
export function createDwellTracker(dwellMs: number) {
  let candidate: string | null = null;
  let since = 0;
  let committed: string | null = null;
  return {
    /** Feed the currently-hovered window label (or null off any window). */
    update(label: string | null, ts: number): { commit: boolean; target: string | null } {
      if (label !== candidate) {
        candidate = label;
        since = ts;
        return { commit: false, target: label };
      }
      if (label != null && label !== committed && ts - since >= dwellMs) {
        committed = label;
        return { commit: true, target: label };
      }
      return { commit: false, target: label };
    },
    /** The currently focused window per this tracker (so external focus changes
     *  can be synced in). */
    setCommitted(label: string | null): void {
      committed = label;
    },
    reset(): void {
      candidate = null;
      since = 0;
      committed = null;
    },
  };
}
