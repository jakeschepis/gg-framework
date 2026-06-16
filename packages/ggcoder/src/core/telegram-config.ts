/**
 * Shared Telegram bot configuration: the `~/.gg/telegram.json` store (bot token
 * + authorized user id) plus bot-token verification. Used by the CLI
 * (`ggcoder telegram` / `ggcoder serve`) and the desktop app sidecar so both
 * read/write the same file with the same validation.
 */
import fs from "node:fs/promises";
import { ensureAppDirs, getAppPaths } from "../config.js";

export interface TelegramConfig {
  botToken: string;
  userId: number;
}

/** Read the saved Telegram config, or null when unset/incomplete. */
export async function loadTelegramConfig(): Promise<TelegramConfig | null> {
  try {
    const raw = await fs.readFile(getAppPaths().telegramFile, "utf-8");
    const data = JSON.parse(raw) as TelegramConfig;
    if (data.botToken && data.userId) return data;
    return null;
  } catch {
    return null;
  }
}

/** Persist the Telegram config with owner-only permissions (0600). */
export async function saveTelegramConfig(config: TelegramConfig): Promise<void> {
  const paths = await ensureAppDirs();
  await fs.writeFile(paths.telegramFile, JSON.stringify(config, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Rough bot-token shape check (`123456789:ABCdef...`). */
export function isValidBotTokenFormat(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]+$/.test(token);
}

export interface BotVerification {
  ok: boolean;
  username?: string;
  firstName?: string;
}

/**
 * Verify a bot token against Telegram's getMe. Returns `{ ok: false }` when the
 * token is malformed or Telegram rejects it (never throws on a bad token).
 */
export async function verifyBotToken(botToken: string): Promise<BotVerification> {
  if (!isValidBotTokenFormat(botToken)) return { ok: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, { method: "POST" });
    const data = (await res.json()) as {
      ok: boolean;
      result?: { username: string; first_name: string };
    };
    if (!data.ok || !data.result) return { ok: false };
    return { ok: true, username: data.result.username, firstName: data.result.first_name };
  } catch {
    return { ok: false };
  }
}
