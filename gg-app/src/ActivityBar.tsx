import { useEffect, useRef, useState } from "react";
import { theme } from "./theme";

// Sparkle ping-pong spinner — mirrors the TUI ActivityIndicator sparkle.
const FRAMES = ["\u00b7", "\u2722", "\u2733", "\u2736", "\u273d", "\u273d"];
const FRAME_MS = 120;

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

interface Props {
  running: boolean;
  /** Accumulated output tokens for the current/just-finished run. */
  tokens: number;
  /** Done-status phrase shown when a run just finished (e.g. "Brewed up a response in 12s"). */
  doneStatus: string | null;
  /** True while the model is actively emitting reasoning/thinking. */
  isThinking: boolean;
  /** Timestamp (ms) the current thinking span began, or null when not thinking. */
  thinkingStartTs: number | null;
  /** Completed thinking time (ms) from earlier spans in this run. */
  thinkingAccumMs: number;
  /** Total steps in the approved plan (0 = no plan tracking). */
  planTotal?: number;
  /** Completed plan steps so far. */
  planDone?: number;
  onCancel: () => void;
}

/**
 * Live activity bar beneath the transcript. While running: sparkle spinner +
 * "Working…" + `elapsed · ↓ N tokens` + esc-to-cancel. After a run: a quiet
 * done-status phrase. Otherwise: a quiet ready line.
 */
export function ActivityBar({
  running,
  tokens,
  doneStatus,
  isThinking,
  thinkingStartTs,
  thinkingAccumMs,
  planTotal = 0,
  planDone = 0,
  onCancel,
}: Props): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [, setNow] = useState(0);
  const startRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    setElapsed(0);
    const spin = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
    const tick = setInterval(() => {
      setElapsed(Date.now() - startRef.current);
      // Repaint so the live thinking timer advances each tick.
      setNow((n) => n + 1);
    }, 250);
    return () => {
      clearInterval(spin);
      clearInterval(tick);
    };
  }, [running]);

  // Plan-step progress (amber "Plan Steps n/total"), shown whenever an approved
  // plan is being implemented — mirrors the ggcoder CLI activity bar.
  const planBadge =
    planTotal > 0 ? (
      <span className="plan-steps-badge">
        <span style={{ color: theme.warning }}>{"Plan Steps"}</span>{" "}
        <span style={{ color: theme.textDim }}>
          {planDone}/{planTotal}
        </span>
      </span>
    ) : null;

  if (!running) {
    // doneStatus is "{verb} {duration} \u2022 \u2193 N tokens" — mirror the TUI by
    // coloring the "\u273b {verb} {duration}" head in success and the token tail dim.
    const [doneHead, ...doneTail] = doneStatus ? doneStatus.split(" \u2022 ") : [];
    return (
      <div className="statusrow" style={{ color: theme.textDim }}>
        {doneStatus ? (
          <span className="statusrow-left">
            <span style={{ color: theme.success }}>
              {"\u273b "}
              {doneHead}
            </span>
            {doneTail.length > 0 && (
              <span style={{ color: theme.textDim }}>{` \u2022 ${doneTail.join(" \u2022 ")}`}</span>
            )}
          </span>
        ) : (
          <span className="statusrow-ready">
            <span style={{ color: theme.accent }}>{"\u273b"}</span>
            <span>Ready for work</span>
          </span>
        )}
        {planBadge && <span style={{ marginLeft: "auto" }}>{planBadge}</span>}
      </div>
    );
  }

  // Live ticking timer: the 250ms `setNow` interval above forces this repaint,
  // and reading the clock during render is what advances the displayed elapsed
  // time each tick. Intentional, not a purity bug.
  const liveThinkingDelta =
    // eslint-disable-next-line react-hooks/purity
    isThinking && thinkingStartTs ? Date.now() - thinkingStartTs : 0;
  const thinkingMs = thinkingAccumMs + liveThinkingDelta;
  const thinkingLabel = isThinking
    ? thinkingMs >= 1000
      ? `thinking for ${formatElapsed(thinkingMs)}`
      : "thinking"
    : thinkingMs >= 1000
      ? `thought for ${formatElapsed(thinkingMs)}`
      : "";

  const meta: { text: string; thinking?: boolean }[] = [{ text: formatElapsed(elapsed) }];
  if (tokens > 0) meta.push({ text: `\u2193 ${formatTokenCount(tokens)} tokens` });
  if (thinkingLabel) meta.push({ text: thinkingLabel, thinking: true });

  return (
    <div className="statusrow running" style={{ color: theme.textMuted }}>
      <span className="statusrow-left">
        <span className="spinner" style={{ color: theme.primary }}>
          {FRAMES[frame]}
        </span>
        <span className="working" style={{ color: theme.text }}>
          {"Working\u2026"}
        </span>
        <span style={{ color: theme.textMuted }}>
          {"("}
          {meta.map((part, i) => (
            <span key={i}>
              {i > 0 ? " \u2022 " : ""}
              <span
                style={{
                  color: part.thinking
                    ? isThinking
                      ? theme.language
                      : theme.textMuted
                    : theme.textMuted,
                }}
              >
                {part.text}
              </span>
            </span>
          ))}
          {")"}
        </span>
      </span>
      {planBadge && <span className="plan-steps-running">{planBadge}</span>}
      <button className="cancel" style={{ color: theme.error }} onClick={onCancel}>
        esc to cancel
      </button>
    </div>
  );
}
