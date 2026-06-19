import { useCallback, useEffect, useState } from "react";
import { theme } from "./theme";
import { authStatus, type AuthProvider } from "./agent";
import { Badge } from "./Badge";
import { BackButton } from "./BackButton";
import { ProviderLoginModal } from "./ProviderLoginModal";

interface Props {
  onClose: () => void;
}

/**
 * Provider login hub. Lists every supported AI provider with a live connection
 * badge; selecting one opens a modal that adapts to OAuth, API key, or both.
 * Mirrors `ggcoder login` in the desktop app.
 */
export function LoginScreen({ onClose }: Props): React.ReactElement {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<AuthProvider | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await authStatus();
    setProviders(list);
    setLoading(false);
    // Keep the open modal's `connected` flag in sync after a change.
    setActive((cur) => (cur ? (list.find((p) => p.value === cur.value) ?? cur) : cur));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Auth status is read natively (Rust) — no sidecar wait, so the list renders
    // immediately even while the agent is still booting or has crashed.
    void authStatus()
      .then((list) => {
        if (!cancelled) {
          setProviders(list);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connectedCount = providers.filter((p) => p.connected).length;

  return (
    <div className="picker">
      <div className="picker-head" data-tauri-drag-region>
        <BackButton label="Back" onClick={onClose} />
        <span className="picker-title">AI Providers</span>
        {!loading && (
          <Badge color={connectedCount > 0 ? theme.success : undefined}>
            {`${connectedCount} connected`}
          </Badge>
        )}
      </div>

      <div className="login-list">
        {loading && (
          <div className="picker-empty" style={{ color: theme.textDim }}>
            {"checking providers\u2026"}
          </div>
        )}
        {providers.map((p) => (
          <button key={p.value} className="login-item" onClick={() => setActive(p)}>
            <span className="login-item-body">
              <span className="login-item-name">{p.label}</span>
              <span className="login-item-desc">{p.description}</span>
            </span>
            <span className="login-methods">
              {p.methods.map((m) => (
                <Badge key={m}>{m === "oauth" ? "OAuth" : "API key"}</Badge>
              ))}
            </span>
            {p.connected ? (
              <Badge color={theme.success}>{"\u25CF Connected"}</Badge>
            ) : (
              <Badge>{"Not connected"}</Badge>
            )}
          </button>
        ))}
      </div>

      {active && (
        <ProviderLoginModal
          provider={active}
          onClose={() => setActive(null)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
