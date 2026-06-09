import { AuthStorage } from "@kenkaiiii/ggcoder";
import type { Provider } from "@kenkaiiii/gg-ai";

/**
 * Credential loader for the bench. Uses the CLI's own `AuthStorage` so OAuth
 * tokens are refreshed on demand (the raw `~/.gg/auth.json` accessToken can be
 * invalidated mid-run, especially for the OpenAI/ChatGPT codex backend).
 */
export interface BenchAuth {
  apiKey: string;
  accountId?: string;
  baseUrl?: string;
}

const storage = new AuthStorage();

export interface ModelTarget {
  label: string;
  provider: Provider;
  model: string;
  /** OAuth provider key in auth.json (usually === provider). */
  authKey: string;
}

/** The two models under test, per the experiment brief. */
export const TARGETS: ModelTarget[] = [
  { label: "opus", provider: "anthropic", model: "claude-opus-4-8", authKey: "anthropic" },
  { label: "gpt-5.5", provider: "openai", model: "gpt-5.5", authKey: "openai" },
];

export async function loadAuth(authKey: string): Promise<BenchAuth> {
  const creds = await storage.resolveCredentials(authKey).catch((err: unknown) => {
    throw new Error(
      `Could not resolve credentials for "${authKey}" (run: ggcoder login). ` +
        (err instanceof Error ? err.message : String(err)),
    );
  });
  return {
    apiKey: creds.accessToken,
    accountId: creds.accountId,
    baseUrl: creds.baseUrl,
  };
}
