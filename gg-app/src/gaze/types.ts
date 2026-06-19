// Shared types for the webcam gaze-to-window-focus feature.
//
// The pipeline is deliberately layered behind a small interface so the camera
// model is swappable and the whole thing is testable without a webcam:
//
//   GazeTracker (camera/model) ──samples──▶ GazeController (smooth + dwell)
//                                                  │
//                                                  ▼
//                                   invoke("gaze_focus", { nx, ny, focus })
//                                                  │ Rust hit-tests windows
//                                                  ▼
//                              emit "gaze-target" { label, focused } → all windows

/** One reading from a tracker. `nx`/`ny` are normalized [0,1] across the
 *  primary monitor (0,0 = top-left). `confidence` is 0 when no face is found. */
export interface GazeSample {
  nx: number;
  ny: number;
  /** 0..1 — below the controller's threshold the sample is ignored. */
  confidence: number;
  /** performance.now() timestamp of the reading. */
  ts: number;
}

/** A swappable gaze source: a camera+model tracker, or the dev mouse faker. */
export interface GazeTracker {
  /** Human-readable name for the status pill ("camera", "mouse (dev)"). */
  readonly kind: string;
  /** Begin producing samples. Rejects if the source is unavailable (e.g. no
   *  camera permission); callers fall back gracefully. */
  start(onSample: (s: GazeSample) => void): Promise<void>;
  /** Stop producing samples and release the camera/listeners. */
  stop(): void;
}

/** Tunables for the smoothing + dwell decision. Persisted in localStorage so a
 *  user can calibrate sensitivity per machine without a code change. */
export interface GazeConfig {
  /** Exponential-moving-average factor for the point, 0..1 (higher = snappier,
   *  lower = smoother/laggier). */
  smoothing: number;
  /** How long (ms) the gaze must rest on one window before focus is committed. */
  dwellMs: number;
  /** Minimum sample confidence to be considered. */
  minConfidence: number;
  /** Throttle (ms) between IPC calls to Rust. */
  throttleMs: number;
}

export const DEFAULT_GAZE_CONFIG: GazeConfig = {
  // Snappier point tracking + a short dwell so focus follows the gaze quickly
  // without flickering on saccades. Tunable live via localStorage (see below).
  smoothing: 0.55,
  dwellMs: 250,
  minConfidence: 0.5,
  throttleMs: 60,
};

/** Read the config, applying any per-machine localStorage overrides. Lets a user
 *  trade focus speed for stability without a rebuild:
 *    gg-app:gaze:smoothing | gg-app:gaze:dwellMs | gg-app:gaze:throttleMs */
export function loadGazeConfig(): GazeConfig {
  const numOr = (key: string, fallback: number): number => {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    smoothing: numOr("gg-app:gaze:smoothing", DEFAULT_GAZE_CONFIG.smoothing),
    dwellMs: numOr("gg-app:gaze:dwellMs", DEFAULT_GAZE_CONFIG.dwellMs),
    minConfidence: DEFAULT_GAZE_CONFIG.minConfidence,
    throttleMs: numOr("gg-app:gaze:throttleMs", DEFAULT_GAZE_CONFIG.throttleMs),
  };
}
