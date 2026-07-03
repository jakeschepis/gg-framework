// XP/rank progress state for one window: initial GET /progress paint, then live
// `progress` SSE frames (broadcast by the sidecar to EVERY window on any award,
// including awards earned in other windows). `levelUpNonce` changes exactly once
// per rank-up event so the UI can fire the toast + confetti celebration once.
import { useEffect, useRef, useState } from "react";
import {
  getProgress,
  subscribe,
  type LevelUpEvent,
  type ProgressSnapshot,
  type SidecarEvent,
} from "./agent";

export interface ProgressState {
  snapshot: ProgressSnapshot | null;
  /** Set when the latest frame carried a rank-up; nonce dedupes celebrations. */
  levelUp: LevelUpEvent | null;
  levelUpNonce: string | null;
  /** True when the rank-up was earned by THIS window's run (gates sound). */
  levelUpOrigin: boolean;
}

export function useProgress(): ProgressState {
  const [snapshot, setSnapshot] = useState<ProgressSnapshot | null>(null);
  const [levelUp, setLevelUp] = useState<LevelUpEvent | null>(null);
  const [levelUpNonce, setLevelUpNonce] = useState<string | null>(null);
  const [levelUpOrigin, setLevelUpOrigin] = useState(false);
  // Nonces already celebrated (or present at initial load — never re-celebrate).
  const seenNonces = useRef<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;

    void getProgress()
      .then((snap) => {
        if (disposed) return;
        if (snap.eventNonce) seenNonces.current.add(snap.eventNonce);
        setSnapshot(snap);
      })
      .catch(() => {
        // Sidecar unavailable — badge stays hidden until the first frame.
      });

    const unsubscribe = subscribe((e: SidecarEvent) => {
      if (e.type !== "progress") return;
      const snap = e.data as ProgressSnapshot;
      setSnapshot(snap);
      const nonce = snap.eventNonce;
      if (snap.levelUp && nonce && !seenNonces.current.has(nonce)) {
        seenNonces.current.add(nonce);
        setLevelUp(snap.levelUp);
        setLevelUpNonce(nonce);
        setLevelUpOrigin(snap.origin === true);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return { snapshot, levelUp, levelUpNonce, levelUpOrigin };
}
