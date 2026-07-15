import type { ReactNode } from "react";
import type { WorkspaceMode } from "./agent";

interface WorkspaceHeaderProps {
  workspaceMode: WorkspaceMode;
  sessionTitle: string | null;
  navHidden: boolean;
  onToggleNav: () => void;
  stripExtras?: ReactNode;
  children: ReactNode;
}

/** Shared code/chat titlebar and collapsible workspace navigation. */
export function WorkspaceHeader({
  workspaceMode,
  sessionTitle,
  navHidden,
  onToggleNav,
  stripExtras,
  children,
}: WorkspaceHeaderProps): React.ReactElement {
  return (
    <div className="chat-head">
      <div className="chat-head-strip" data-tauri-drag-region>
        <span className="chat-head-title" data-tauri-drag-region>
          {sessionTitle ?? (workspaceMode === "chat" ? "GG Chat" : "GG Coder")}
        </span>
        {stripExtras}
        <button
          className="nav-toggle"
          title={navHidden ? "Show nav buttons" : "Hide nav buttons"}
          aria-label={navHidden ? "Show nav buttons" : "Hide nav buttons"}
          aria-expanded={!navHidden}
          aria-controls="workspace-nav"
          onClick={onToggleNav}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ display: "block" }}
            aria-hidden="true"
          >
            <polyline points={navHidden ? "6 9 12 15 18 9" : "6 15 12 9 18 15"} />
          </svg>
        </button>
      </div>

      {!navHidden && (
        <div id="workspace-nav" className="chat-head-nav" data-tauri-drag-region>
          {children}
        </div>
      )}
    </div>
  );
}
