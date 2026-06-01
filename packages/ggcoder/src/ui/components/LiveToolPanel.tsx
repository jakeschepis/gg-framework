import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/theme.js";
import { ToolUseLoader } from "./ToolUseLoader.js";
import { buildToolLineParts, type ToolLinePart } from "../tool-line-summary.js";
import { toolTonePalette } from "../transcript/tool-presentation.js";

/** A single tool action shown in the live panel. */
export interface LiveToolEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done";
  isError?: boolean;
  /** Tool result string (done only) — drives the dim inline summary. */
  result?: string;
  /** Structured tool details (e.g. edit diff) — drives the +/− summary. */
  details?: unknown;
}

/** Max rows shown at once — older entries roll off the top. */
export const LIVE_TOOL_PANEL_ROWS = 3;

interface LiveToolPanelProps {
  entries: readonly LiveToolEntry[];
  columns: number;
}

/** Clamp styled parts to a total display budget, trimming the tail with an ellipsis. */
function clampParts(parts: readonly ToolLinePart[], budget: number): ToolLinePart[] {
  const out: ToolLinePart[] = [];
  let used = 0;
  for (const part of parts) {
    if (used >= budget) break;
    const remaining = budget - used;
    if (part.text.length <= remaining) {
      out.push(part);
      used += part.text.length;
    } else {
      out.push({ ...part, text: `${part.text.slice(0, Math.max(0, remaining - 1))}…` });
      break;
    }
  }
  return out;
}

/**
 * A pinned, in-place panel (above the activity bar) that shows the most recent
 * tool actions as a rolling 3-row window. Tools no longer spam the scrollback —
 * this panel mutates in place while the agent works.
 *
 * Each row mirrors the previous tool styling: a status dot, a bold tone-colored
 * verb, the plain detail, and a dim inline summary (`· 42 lines`). Rows are
 * hard-truncated to the terminal width so the panel never wraps or overflows.
 */
export function LiveToolPanel({ entries, columns }: LiveToolPanelProps) {
  const theme = useTheme();
  if (entries.length === 0) return null;

  const visible = entries.slice(-LIVE_TOOL_PANEL_ROWS);
  // Budget: full width minus left padding (1) and the status marker (2).
  const textBudget = Math.max(8, columns - 1 - 2);

  return (
    <Box flexDirection="column" paddingLeft={1} width={columns}>
      {visible.map((entry) => {
        const done = entry.status === "done";
        const status = done ? (entry.isError ? "error" : "done") : "running";
        const parts = clampParts(
          buildToolLineParts(entry.name, entry.args, {
            done,
            isError: entry.isError,
            result: entry.result,
            details: entry.details,
          }),
          textBudget,
        );
        const verbTone = parts[0]?.tone;
        const verbColor = entry.isError
          ? theme.error
          : verbTone
            ? toolTonePalette(theme, verbTone).primary
            : theme.toolName;

        return (
          <Box key={entry.id} flexDirection="row">
            <ToolUseLoader status={status} staticDisplay color={done ? undefined : verbColor} />
            <Text wrap="truncate-end">
              {parts.map((part, i) => {
                const color =
                  part.tone || part.bold ? verbColor : part.dim ? theme.textDim : theme.text;
                return (
                  <Text key={i} bold={part.bold} color={color}>
                    {part.text}
                  </Text>
                );
              })}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
