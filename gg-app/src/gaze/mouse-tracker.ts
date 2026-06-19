import type { GazeSample, GazeTracker } from "./types";

// Dev/test tracker that fakes "gaze" from the mouse position. Lets the whole
// pipeline (smoothing → dwell → Rust hit-test → highlight/focus) be exercised
// without a webcam or the MediaPipe model. The pointer's position within THIS
// window is mapped to a normalized point across the monitor by combining the
// window's screen offset with the pointer offset — close enough to drive and
// debug the focus plumbing.
//
// Enable by setting localStorage "gg-app:gaze:tracker" = "mouse".
export function createMouseTracker(): GazeTracker {
  let handler: ((e: MouseEvent) => void) | null = null;
  return {
    kind: "mouse (dev)",
    async start(onSample: (s: GazeSample) => void): Promise<void> {
      handler = (e: MouseEvent) => {
        // Approximate a monitor-normalized point: where the window sits on the
        // virtual screen plus where the pointer sits in the window. screenX/Y
        // are already in screen pixels, so divide by the full screen size.
        const sw = window.screen.width || 1;
        const sh = window.screen.height || 1;
        onSample({
          nx: e.screenX / sw,
          ny: e.screenY / sh,
          confidence: 1,
          ts: performance.now(),
        });
      };
      window.addEventListener("mousemove", handler);
    },
    stop(): void {
      if (handler) window.removeEventListener("mousemove", handler);
      handler = null;
    },
  };
}
