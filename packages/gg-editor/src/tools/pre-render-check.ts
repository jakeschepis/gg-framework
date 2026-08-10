import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { compact } from "../core/format.js";
import type { VideoHost } from "../core/hosts/types.js";
import { measureLoudness, PLATFORM_TARGETS } from "../core/loudness.js";
import { checkFfmpeg } from "../core/media/ffmpeg.js";

const PreRenderCheckParams = z.object({
  loudnessSource: z
    .string()
    .optional()
    .describe(
      "If supplied, measure loudness on this rendered preview / mixed audio file. " +
        "Skipped when omitted (timeline-only checks still run).",
    ),
  loudnessTarget: z
    .enum([
      "youtube",
      "spotify",
      "apple-podcasts",
      "podcast",
      "broadcast-r128",
      "tiktok",
      "instagram",
    ])
    .optional()
    .describe("Platform target for loudness comparison. Omit to skip loudness verdict."),
  expectCaptions: z
    .boolean()
    .optional()
    .describe("If true, warn when no captions/subtitles markers are present. Default false."),
});

interface CheckIssue {
  severity: "ok" | "warn" | "block";
  note: string;
}

export function createPreRenderCheckTool(
  host: VideoHost,
  cwd: string,
): AgentTool<typeof PreRenderCheckParams> {
  return {
    name: "pre_render_check",
    description:
      "Composite QA pass before render. READ-ONLY. Verifies: timeline isn't empty; no red " +
      "PAUSE markers (user-requested holds); loudness within ±1 LU + TP < -1 dBTP of " +
      "platform target; (optional) captions present. Returns severity-tagged issues. " +
      "Block-level issues mean DON'T render until resolved. Run this before every final render.",
    parameters: PreRenderCheckParams,
    async execute({ loudnessSource, loudnessTarget, expectCaptions }, ctx) {
      const issues: CheckIssue[] = [];

      // Timeline state
      try {
        const tl = await host.getTimeline();
        if (!tl.clips || tl.clips.length === 0) {
          issues.push({ severity: "block", note: "timeline is empty" });
        }
        if (expectCaptions) {
          const hasCaptionsClip = tl.clips.some(
            (c) => c.trackKind === "audio" || c.name.toLowerCase().includes("subtitle"),
          );
          if (!hasCaptionsClip) {
            issues.push({
              severity: "warn",
              note: "expectCaptions=true but no audio/subtitle track detected",
            });
          }
        }
      } catch (e) {
        issues.push({
          severity: "warn",
          note: `getTimeline failed: ${(e as Error).message}`,
        });
      }

      // Markers — surface unresolved PAUSE markers as block-level
      try {
        const markers = await host.getMarkers();
        const paused = markers.filter((m) => (m.note ?? "").toUpperCase().includes("PAUSE"));
        if (paused.length > 0) {
          issues.push({
            severity: "block",
            note: `${paused.length} unresolved PAUSE marker(s); resolve before rendering`,
          });
        }
      } catch {
        // No NLE attached — ignore.
      }

      // Loudness verdict (when source supplied)
      let loudness:
        { i: number; tp: number; lra: number; verdict: "ok" | "off-target" } | undefined;
      if (loudnessSource) {
        if (!checkFfmpeg()) {
          issues.push({
            severity: "warn",
            note: "ffmpeg not on PATH \u2014 loudness check skipped",
          });
        } else {
          try {
            const abs = resolvePath(cwd, loudnessSource);
            const m = await measureLoudness(abs, { signal: ctx.signal });
            const tgt = loudnessTarget ? PLATFORM_TARGETS[loudnessTarget] : undefined;
            let verdict: "ok" | "off-target" = "ok";
            if (tgt) {
              const iDelta = Math.abs(m.inputI - tgt.integratedLufs);
              const tpCeiling = tgt.truePeakDb ?? -1;
              if (iDelta > 1) {
                verdict = "off-target";
                issues.push({
                  severity: "block",
                  note: `integrated loudness ${m.inputI.toFixed(1)} LUFS off target ${tgt.integratedLufs} by ${iDelta.toFixed(1)} LU \u2014 run normalize_loudness`,
                });
              }
              if (m.inputTp > tpCeiling) {
                verdict = "off-target";
                issues.push({
                  severity: "block",
                  note: `true peak ${m.inputTp.toFixed(1)} dBTP exceeds ${tpCeiling} \u2014 run normalize_loudness`,
                });
              }
            }
            loudness = {
              i: +m.inputI.toFixed(2),
              tp: +m.inputTp.toFixed(2),
              lra: +m.inputLra.toFixed(2),
              verdict,
            };
          } catch (e) {
            issues.push({
              severity: "warn",
              note: `loudness measure failed: ${(e as Error).message}`,
            });
          }
        }
      }

      const blocked = issues.some((i) => i.severity === "block");
      const warned = issues.some((i) => i.severity === "warn");
      const status: "ok" | "warn" | "block" = blocked ? "block" : warned ? "warn" : "ok";
      return compact({
        status,
        ...(loudness ? { loudness } : {}),
        issues,
      });
    },
  };
}

// Surface CheckIssue type (test reuse + future composability).
export type { CheckIssue };
