import { useEffect, useRef, useState } from "react";

// Per-app UI zoom. Cmd/Ctrl + "+" / "-" scales the whole webview text up/down
// in 5% steps; Cmd/Ctrl + "0" resets to 100%. A centered overlay flashes the
// current level on each change, then fades out.
//
// Cmd is used on macOS, Ctrl on Windows/Linux (we accept either modifier).
//
// Why CSS `zoom` on <html> (not Tauri's webview.setZoom): it's instant, needs
// no IPC/permissions, and lets us own the keybindings + visual feedback. The
// `zoom` property is supported by all three Tauri webviews — WKWebView (macOS),
// WebView2/Chromium (Windows), and WebKitGTK (Linux).
//
// Storage is shared across all windows (same tauri:// origin), so a level set in
// one window persists and new windows inherit it. A `storage` listener also
// live-syncs the change into already-open windows.

const STORAGE_KEY = "gg-app:zoom";
const STEP = 0.05; // 5% increments
const MIN = 0.5; // 50%
const MAX = 2.0; // 200%
const OVERLAY_MS = 900; // how long the level overlay stays before fading

function clamp(z: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(z / STEP) * STEP));
}

function loadZoom(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(raw) && raw > 0 ? clamp(raw) : 1;
}

function applyZoom(z: number): void {
  // `zoom` isn't in the typed CSSStyleDeclaration; set it via the property.
  document.documentElement.style.setProperty("zoom", String(z));
}

export function ZoomController(): React.ReactElement | null {
  const [zoom, setZoom] = useState<number>(loadZoom);
  // Bumped on every change to (re)trigger the overlay; null hides it initially.
  const [flash, setFlash] = useState<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply + persist whenever the level changes.
  useEffect(() => {
    applyZoom(zoom);
    localStorage.setItem(STORAGE_KEY, String(zoom));
  }, [zoom]);

  // Keep other open windows in sync when one of them changes the shared level.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== STORAGE_KEY || e.newValue == null) return;
      const next = clamp(Number(e.newValue));
      if (Number.isFinite(next)) setZoom(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Hotkeys: Cmd/Ctrl + ( = / + ) zoom in, ( - / _ ) zoom out, ( 0 ) reset.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key;
      let next: number;
      if (k === "=" || k === "+") next = clamp(zoom + STEP);
      else if (k === "-" || k === "_") next = clamp(zoom - STEP);
      else if (k === "0") next = 1;
      else return;
      e.preventDefault();
      setZoom(next);
      setFlash((n) => (n ?? 0) + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  // Auto-hide the overlay a beat after the last change.
  useEffect(() => {
    if (flash == null) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setFlash(null), OVERLAY_MS);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [flash]);

  if (flash == null) return null;

  // The container fills the (zoomed) viewport and flex-centers the card. The
  // card counter-scales the page zoom so it reports the level at a constant
  // on-screen size — applied to the card (not the container) so centering holds
  // at every level.
  return (
    <div className="zoom-overlay" aria-hidden>
      <div key={flash} className="zoom-overlay-card" role="status" style={{ zoom: 1 / zoom }}>
        <span className="zoom-overlay-pct">{Math.round(zoom * 100)}%</span>
        <span className="zoom-overlay-label">Zoom</span>
      </div>
    </div>
  );
}
