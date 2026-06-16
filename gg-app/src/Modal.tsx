import { useEffect } from "react";
import { theme } from "./theme";

/**
 * Reusable centered modal with a dim backdrop. Closes on Escape or backdrop
 * click. Presentational — the caller owns the body and actions.
 */
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        style={{ background: theme.surface2, borderColor: theme.border }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title" style={{ color: theme.text }}>
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}
