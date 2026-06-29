import React from "react";
import { PlanOverlay } from "./PlanOverlay.js";
import { SkillsOverlay } from "./SkillsOverlay.js";

export type FullScreenOverlayKind = "skills" | "plan";

interface FullScreenOverlayRouterProps {
  overlay: FullScreenOverlayKind | null;
  cwd: string;
  planAutoExpand: boolean;
  onCloseSkills: () => void;
  onClosePlan: () => void;
  onApprovePlan: (planPath: string) => void;
  onRejectPlan: (planPath: string, feedback: string) => void;
}

export function FullScreenOverlayRouter({
  overlay,
  cwd,
  planAutoExpand,
  onCloseSkills,
  onClosePlan,
  onApprovePlan,
  onRejectPlan,
}: FullScreenOverlayRouterProps) {
  if (overlay === "skills") {
    return <SkillsOverlay cwd={cwd} onClose={onCloseSkills} />;
  }

  if (overlay === "plan") {
    return (
      <PlanOverlay
        cwd={cwd}
        autoExpandNewest={planAutoExpand}
        onClose={onClosePlan}
        onApprove={onApprovePlan}
        onReject={onRejectPlan}
      />
    );
  }

  return null;
}
