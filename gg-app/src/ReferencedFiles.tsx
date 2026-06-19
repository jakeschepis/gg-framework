import { AtSign, X } from "lucide-react";
import { theme } from "./theme";

/**
 * Inline-code-styled chips for each `@`-referenced file. The paths are tracked
 * in state (not in the textarea text); removing a chip drops it from that state.
 */
export function ReferencedFiles({
  paths,
  onRemove,
}: {
  paths: readonly string[];
  onRemove: (path: string) => void;
}): React.ReactElement | null {
  if (paths.length === 0) return null;
  return (
    <div className="mention-bar">
      {paths.map((p) => (
        <div
          key={p}
          className="mention-chip"
          title={p}
          style={{ background: theme.surface1, borderColor: theme.border }}
        >
          <AtSign size={11} className="mention-chip-at" style={{ color: theme.accent }} />
          <span className="mention-chip-name" style={{ color: theme.code }}>
            {p}
          </span>
          <button
            className="mention-chip-remove"
            aria-label={`Remove ${p}`}
            onClick={() => onRemove(p)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Heading that marks the appended referenced-files block (shared by writer +
 *  parser so history restore can recover the chips). */
const REF_HEADING = "Referenced files:";

/** Append referenced file paths to a prompt as a compact block so the agent
 *  knows which files to read. Returns the prompt unchanged when there are none. */
export function appendReferencedFiles(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const block = `${REF_HEADING}\n${paths.map((p) => `- ${p}`).join("\n")}`;
  return text ? `${text}\n\n${block}` : block;
}

/** Inverse of appendReferencedFiles: split a stored prompt back into its clean
 *  text and the referenced paths, for hydrating a resumed session's bubbles. */
export function parseReferencedFiles(full: string): { text: string; files: string[] } {
  const idx = full.lastIndexOf(`\n\n${REF_HEADING}\n`);
  // Also handle a chips-only prompt (no leading text).
  const headOnly = full.startsWith(`${REF_HEADING}\n`);
  if (idx < 0 && !headOnly) return { text: full, files: [] };
  const blockStart = headOnly ? 0 : idx + 2; // skip the "\n\n"
  const text = headOnly ? "" : full.slice(0, idx);
  const lines = full.slice(blockStart).split("\n").slice(1); // drop the heading
  const files: string[] = [];
  for (const line of lines) {
    const m = /^- (.+)$/.exec(line);
    if (m && m[1]) files.push(m[1]);
    else break; // block is contiguous; stop at the first non-item line
  }
  return files.length > 0 ? { text, files } : { text: full, files: [] };
}
