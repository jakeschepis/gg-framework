import { useEffect, useRef } from "react";
import { theme } from "./theme";
import type { ModelOption } from "./agent";

interface Props {
  models: readonly ModelOption[];
  currentModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

/**
 * Upward-opening model picker anchored to the footer. Shows just the model
 * names in a multi-column grid (there are many models), with the active one
 * highlighted. Closes on outside-click or Escape.
 */
export function ModelMenu({ models, currentModel, onSelect, onClose }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener("mousedown", onDocClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="model-menu"
      ref={ref}
      style={{ background: theme.surface2, borderColor: theme.border }}
    >
      <div className="model-menu-title" style={{ color: theme.textMuted }}>
        select model
      </div>
      <div className="model-menu-grid">
        {models.map((m) => {
          const active = m.id === currentModel;
          return (
            <button
              key={`${m.provider}:${m.id}`}
              className={`model-menu-item${active ? " active" : ""}`}
              style={{
                color: active ? theme.primary : theme.text,
                background: active ? theme.surface2 : "transparent",
              }}
              onClick={() => onSelect(m.id)}
              title={m.provider}
            >
              {m.id}
            </button>
          );
        })}
      </div>
    </div>
  );
}
