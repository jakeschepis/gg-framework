interface UiSlashCommandActions {
  openModelSelector: () => void;
  compactConversation: () => Promise<void>;
  quit: () => void;
  clearSession: () => void;
  openThemeSelector: () => void;
  toggleMarkdown: () => void;
  clearApprovedPlan: () => void;
  openGoalsPicker: () => void;
  /** User-facing entry point to plan mode. Optional objective seeds the first agent turn. */
  enterPlanMode: (objective: string) => Promise<void>;
  /** Open the PlanOverlay browser for past plans in .gg/plans/. */
  openPlanBrowser: () => void;
}

export async function handleUiSlashCommand(
  trimmed: string,
  actions: UiSlashCommandActions,
): Promise<boolean> {
  if (trimmed === "/model" || trimmed === "/m" || trimmed === "/models") {
    actions.openModelSelector();
    return true;
  }

  if (trimmed === "/compact" || trimmed === "/c") {
    await actions.compactConversation();
    return true;
  }

  if (trimmed === "/quit" || trimmed === "/q" || trimmed === "/exit") {
    actions.quit();
    return true;
  }

  if (trimmed === "/clear") {
    actions.clearSession();
    return true;
  }

  if (trimmed === "/theme" || trimmed === "/t") {
    actions.openThemeSelector();
    return true;
  }

  if (trimmed === "/markdown" || trimmed === "/md") {
    actions.toggleMarkdown();
    return true;
  }

  if (trimmed === "/clearplan") {
    actions.clearApprovedPlan();
    return true;
  }

  if (trimmed === "/goals") {
    actions.openGoalsPicker();
    return true;
  }

  // Open the read-only plan browser overlay.
  if (trimmed === "/plans") {
    actions.openPlanBrowser();
    return true;
  }

  // Enter plan mode, with optional objective to seed the first turn.
  // Matches exact "/plan", "/p", and the prefixed forms with an arg.
  if (
    trimmed === "/plan" ||
    trimmed === "/p" ||
    trimmed.startsWith("/plan ") ||
    trimmed.startsWith("/p ")
  ) {
    const objective = trimmed.replace(/^\/p(lan)?\s*/, "").trim();
    await actions.enterPlanMode(objective);
    return true;
  }

  return false;
}
