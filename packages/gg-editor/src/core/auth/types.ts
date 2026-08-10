export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** ms epoch */
  expiresAt: number;
  /** OpenAI chatgpt_account_id from JWT (when applicable). */
  accountId?: string;
  /** Optional custom API base URL. */
  baseUrl?: string;
}

export interface OAuthLoginCallbacks {
  onOpenUrl: (url: string) => void;
  onPromptCode: (message: string) => Promise<string>;
  onStatus: (message: string) => void;
}

/** All providers gg-editor supports — mirrors ggcoder's set. */
export type SupportedAuthProvider =
  "anthropic" | "openai" | "glm" | "moonshot" | "xiaomi" | "minimax" | "deepseek" | "openrouter";

/** Providers that use static API keys (no OAuth refresh). */
export const STATIC_KEY_PROVIDERS = new Set<SupportedAuthProvider>([
  "glm",
  "moonshot",
  "xiaomi",
  "minimax",
  "deepseek",
  "openrouter",
]);

/** Providers that use OAuth (PKCE). */
export const OAUTH_PROVIDERS = new Set<SupportedAuthProvider>(["anthropic", "openai"]);
