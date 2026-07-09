import type { OAuthCredentials } from "./oauth/types.js";

export type SubscriptionUsageProvider = "anthropic" | "openai";

export interface SubscriptionUsageWindow {
  kind: "current" | "weekly";
  label: string;
  usedPercent: number;
  /** Unix epoch milliseconds. */
  resetsAt?: number;
}

export interface SubscriptionUsageSnapshot {
  provider: SubscriptionUsageProvider;
  displayName: string;
  windows: SubscriptionUsageWindow[];
  fetchedAt: number;
}

export class SubscriptionUsageError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SubscriptionUsageError";
  }
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface FetchSubscriptionUsageOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  now?: () => number;
}

interface AnthropicWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface AnthropicUsageResponse {
  five_hour?: AnthropicWindow | null;
  seven_day?: AnthropicWindow | null;
}

interface CodexWindow {
  limit_window_seconds?: unknown;
  used_percent?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
}

interface CodexUsageResponse {
  rate_limit?: {
    primary_window?: CodexWindow | null;
    secondary_window?: CodexWindow | null;
  } | null;
}

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.min(100, Math.max(0, number));
}

function isoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function unixTimestamp(value: unknown): number | undefined {
  const seconds = finiteNumber(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function codexResetAt(window: CodexWindow, now: number): number | undefined {
  const absolute = unixTimestamp(window.reset_at);
  if (absolute !== undefined) return absolute;
  const afterSeconds = finiteNumber(window.reset_after_seconds);
  return afterSeconds === undefined ? undefined : now + afterSeconds * 1000;
}

function currentWindowLabel(seconds: unknown, fallbackHours: number): string {
  const duration = finiteNumber(seconds);
  const hours = Math.max(1, Math.round((duration ?? fallbackHours * 3600) / 3600));
  return `${hours}-hour`;
}

async function readUsageResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new SubscriptionUsageError(
      `Subscription usage request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SubscriptionUsageError("Subscription usage response was not valid JSON");
  }
}

async function fetchAnthropicUsage(
  credentials: Pick<OAuthCredentials, "accessToken">,
  fetchFn: FetchFn,
  signal: AbortSignal,
  now: () => number,
): Promise<SubscriptionUsageSnapshot> {
  const response = await fetchFn(ANTHROPIC_USAGE_URL, {
    method: "GET",
    signal,
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "ggcoder",
    },
  });
  const data = (await readUsageResponse(response)) as AnthropicUsageResponse;
  const windows: SubscriptionUsageWindow[] = [];
  const currentPercent = clampPercent(data.five_hour?.utilization);
  if (currentPercent !== undefined) {
    windows.push({
      kind: "current",
      label: "5-hour",
      usedPercent: currentPercent,
      resetsAt: isoTimestamp(data.five_hour?.resets_at),
    });
  }
  const weeklyPercent = clampPercent(data.seven_day?.utilization);
  if (weeklyPercent !== undefined) {
    windows.push({
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyPercent,
      resetsAt: isoTimestamp(data.seven_day?.resets_at),
    });
  }
  return {
    provider: "anthropic",
    displayName: "Anthropic",
    windows,
    fetchedAt: now(),
  };
}

async function fetchCodexUsage(
  credentials: Pick<OAuthCredentials, "accessToken" | "accountId">,
  fetchFn: FetchFn,
  signal: AbortSignal,
  now: () => number,
): Promise<SubscriptionUsageSnapshot> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: "application/json",
    originator: "ggcoder",
    "User-Agent": "ggcoder",
  };
  if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
  const response = await fetchFn(CODEX_USAGE_URL, { method: "GET", signal, headers });
  const data = (await readUsageResponse(response)) as CodexUsageResponse;
  const windows: SubscriptionUsageWindow[] = [];
  const current = data.rate_limit?.primary_window;
  const currentPercent = clampPercent(current?.used_percent);
  if (current && currentPercent !== undefined) {
    windows.push({
      kind: "current",
      label: currentWindowLabel(current.limit_window_seconds, 5),
      usedPercent: currentPercent,
      resetsAt: codexResetAt(current, now()),
    });
  }
  const weekly = data.rate_limit?.secondary_window;
  const weeklyPercent = clampPercent(weekly?.used_percent);
  if (weekly && weeklyPercent !== undefined) {
    windows.push({
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyPercent,
      resetsAt: codexResetAt(weekly, now()),
    });
  }
  return {
    provider: "openai",
    displayName: "Codex",
    windows,
    fetchedAt: now(),
  };
}

/**
 * Fetch subscription quota windows with an already-resolved OAuth credential.
 * Tokens stay server-side: callers expose only the normalized percentages and
 * reset timestamps to their UI.
 */
export async function fetchSubscriptionUsage(
  provider: SubscriptionUsageProvider,
  credentials: Pick<OAuthCredentials, "accessToken" | "accountId">,
  options: FetchSubscriptionUsageOptions = {},
): Promise<SubscriptionUsageSnapshot> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 8_000);
  try {
    return provider === "anthropic"
      ? await fetchAnthropicUsage(credentials, fetchFn, signal, now)
      : await fetchCodexUsage(credentials, fetchFn, signal, now);
  } catch (error) {
    if (error instanceof SubscriptionUsageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SubscriptionUsageError(message);
  }
}
