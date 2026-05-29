import type { SlashCommandInfo } from "@kenkaiiii/ggcoder/ui";

/**
 * Slash commands the boss CLI recognizes. Shape matches ggcoder's
 * SlashCommandInfo so the existing SlashCommandMenu in InputArea renders them.
 *
 * The actual handlers live in BossApp's handleSubmit — we just declare the
 * surface here so the menu is in one place.
 */
export const BOSS_SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: "help", aliases: ["?"], description: "Show available commands" },
  {
    name: "model-boss",
    aliases: ["m", "model", "models"],
    description: "Switch the orchestrator's model",
  },
  { name: "model-workers", aliases: [], description: "Switch every worker's model" },
  { name: "compact", aliases: [], description: "Compact the boss's context now" },
  { name: "clear", aliases: [], description: "Clear chat history and terminal" },
  { name: "radio", aliases: [], description: "Stream a free internet radio station" },
  { name: "quit", aliases: ["q", "exit"], description: "Exit gg-boss" },
];

export function isSlashCommand(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

export interface ParsedSlashCommand {
  name: string;
  args: string;
}

export function parseSlash(value: string): ParsedSlashCommand | null {
  if (!isSlashCommand(value)) return null;
  const rest = value.slice(1).trim();
  if (!rest) return null;
  const space = rest.indexOf(" ");
  if (space === -1) return { name: rest.toLowerCase(), args: "" };
  return { name: rest.slice(0, space).toLowerCase(), args: rest.slice(space + 1).trim() };
}

/** Resolve aliases to the canonical command name. */
export function canonicalName(name: string): string | null {
  for (const cmd of BOSS_SLASH_COMMANDS) {
    if (cmd.name === name) return cmd.name;
    if (cmd.aliases.includes(name)) return cmd.name;
  }
  return null;
}

export function buildHelpText(): string {
  const lines: string[] = ["**gg-boss commands**", ""];
  for (const cmd of BOSS_SLASH_COMMANDS) {
    const aliases =
      cmd.aliases.length > 0 ? ` (${cmd.aliases.map((a) => "/" + a).join(", ")})` : "";
    lines.push(`- \`/${cmd.name}\`${aliases} — ${cmd.description}`);
  }
  lines.push("");
  lines.push("**Global keybindings**");
  lines.push("- `Ctrl+T` — open the Tasks pane");
  lines.push("- `Tab` — switch project scope (All / per-project pill in the input)");
  lines.push("- `Shift+Tab` — cycle the boss's thinking level, then off");
  lines.push("- `Esc` — interrupt the boss while it's running");
  lines.push("- `Ctrl+C` (twice) — exit");
  lines.push("");
  lines.push("**Inside the Tasks pane (Ctrl+T)**");
  lines.push("- `↑` / `↓` (or `k` / `j`) — navigate tasks");
  lines.push("- `r` — run all pending and blocked tasks across idle workers");
  lines.push("- `d` — delete the selected task");
  lines.push("- `Esc` — close the Tasks pane");
  lines.push("");
  lines.push("**Inside model pickers (`/model`, `/models`, `/model-boss`, `/model-workers`)**");
  lines.push("- `↑` / `↓` — navigate models");
  lines.push("- `Enter` — select");
  lines.push("- `Esc` — cancel");
  lines.push("");
  lines.push("**Radio** (`/radio`)");
  lines.push("- Pick a station to stream while you work, or select `Off` to stop.");
  lines.push("- Requires `mpv` (recommended), `ffplay`, `mpg123`, or `vlc/cvlc` installed.");
  lines.push("");
  lines.push("**Input area**");
  lines.push("- `↑` / `↓` — recall previous prompts (when input is empty)");
  lines.push("- `Enter` — send  ·  `Shift+Enter` — newline");
  lines.push("- `/` — open the slash-command menu (Tab / arrows to pick, Enter to insert)");
  return lines.join("\n");
}
