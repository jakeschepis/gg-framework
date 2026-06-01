import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

const RATE_LIMIT_PATTERNS = [
  "you appear to be a bot",
  "unusual traffic",
  "captcha",
  "rate limit",
  "too many requests",
  "blocked",
  "access denied",
  "sorry, you have been blocked",
  "anomaly-modal",
  "unfortunately, bots use duckduckgo",
  "challenge-form",
];

type SearchEngine = "DuckDuckGo" | "DuckDuckGoLite" | "Brave" | "Bing" | "Google";
const ENGINES: SearchEngine[] = ["DuckDuckGo", "DuckDuckGoLite", "Brave", "Bing", "Google"];

type TimeRange = "day" | "week" | "month" | "year";

interface SearchFilters {
  includeDomains: string[];
  excludeDomains: string[];
  timeRange?: TimeRange;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface FilterStats {
  ads: number;
  spam: number;
  duplicates: number;
  domainFiltered: number;
}

interface FilteredResults {
  results: SearchResult[];
  stats: FilterStats;
}

/**
 * Normalize a domain to lowercase punycode hostname, defending against Unicode
 * homograph spoofing. Returns null for un-parseable input.
 */
export function normalizeDomain(domain: string): string | null {
  const trimmed = domain.trim().replace(/^\*\.?/, "");
  if (!trimmed) return null;
  try {
    return new URL(`https://${trimmed.replace(/^https?:\/\//i, "")}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeDomains(domains: string[] | undefined): string[] {
  if (!domains) return [];
  const out: string[] = [];
  for (const d of domains) {
    const n = normalizeDomain(d);
    if (n) out.push(n);
  }
  return out;
}

/** True if `hostname` equals or is a subdomain of `domain`. */
function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

const AD_URL_PATTERNS = [
  /(?:^|\.)googleadservices\.com$/i,
  /(?:^|\.)adservice\.google\./i,
  /(?:^|\.)doubleclick\.net$/i,
  /(?:^|\.)googlesyndication\.com$/i,
  /(?:^|\.)adsystem\.com$/i,
  /(?:^|\.)adnxs\.com$/i,
  /(?:^|\.)taboola\.com$/i,
  /(?:^|\.)outbrain\.com$/i,
  /(?:^|\.)ads\.twitter\.com$/i,
  /(?:^|\.)ads\.linkedin\.com$/i,
  /(?:^|\.)awin1\.com$/i,
  /(?:^|\.)shareasale\.com$/i,
  /(?:^|\.)cj\.com$/i,
  /(?:^|\.)impact\.com$/i,
  /(?:^|\.)linksynergy\.com$/i,
];

const SPAM_HOST_PATTERNS = [/coupon/i, /promo-code/i, /deals/i, /discount/i];

const AD_QUERY_KEYS = new Set([
  "ad_domain",
  "ad_provider",
  "ad_type",
  "adurl",
  "adurlurl",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
]);

const TRACKING_QUERY_KEYS = new Set([
  ...AD_QUERY_KEYS,
  "fbclid",
  "igshid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "vero_id",
  "ref",
  "ref_src",
  "source",
  "spm",
  "scid",
  "campaign",
  "affiliate",
  "aff",
  "tag",
]);

const REDIRECT_QUERY_KEYS = [
  "uddg",
  "url",
  "q",
  "u",
  "to",
  "target",
  "dest",
  "destination",
  "redirect",
  "redirect_url",
  "r",
  "u3",
  "adurl",
];

const AD_PATH_PATTERNS = [/^\/y\.js$/i, /^\/aclk$/i, /^\/aclick$/i, /^\/pagead\//i];

// ── HTML helpers ──────────────────────────────────────────

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function cleanHTML(text: string): string {
  return decodeHTMLEntities(text.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function parseHttpUrl(rawURL: string, base = "https://duckduckgo.com"): URL | null {
  try {
    const parsed = new URL(rawURL, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function getNestedRedirectUrl(parsed: URL): string | null {
  for (const key of REDIRECT_QUERY_KEYS) {
    const value = parsed.searchParams.get(key);
    if (!value) continue;
    const nested = parseHttpUrl(value);
    if (nested) return nested.href;
  }
  return null;
}

function normalizeSearchUrl(rawURL: string, depth = 0): URL | null {
  if (depth > 4) return null;
  const expandedURL = rawURL.startsWith("//") ? `https:${rawURL}` : rawURL;
  const parsed = parseHttpUrl(expandedURL);
  if (!parsed) return null;

  const nested = getNestedRedirectUrl(parsed);
  if (nested) {
    const unwrapped = normalizeSearchUrl(nested, depth + 1);
    if (unwrapped) return unwrapped;
  }

  return parsed;
}

export function canonicalSearchResultUrl(rawURL: string): string | null {
  const parsed = normalizeSearchUrl(rawURL);
  if (!parsed) return null;
  if (isAdSearchResultUrl(parsed.href)) return null;

  parsed.hash = "";
  const keptParams = [...parsed.searchParams.entries()]
    .filter(([key]) => {
      const lowerKey = key.toLowerCase();
      return !lowerKey.startsWith("utm_") && !TRACKING_QUERY_KEYS.has(lowerKey);
    })
    .sort(
      ([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue),
    );

  parsed.search = "";
  for (const [key, value] of keptParams) {
    parsed.searchParams.append(key, value);
  }

  return parsed.href;
}

export function isAdSearchResultUrl(rawURL: string): boolean {
  const parsed = parseHttpUrl(rawURL);
  if (!parsed) return true;

  const hostname = parsed.hostname.toLowerCase();
  if (AD_URL_PATTERNS.some((pattern) => pattern.test(hostname))) return true;
  if (AD_PATH_PATTERNS.some((pattern) => pattern.test(parsed.pathname))) return true;

  for (const key of parsed.searchParams.keys()) {
    if (AD_QUERY_KEYS.has(key.toLowerCase())) return true;
  }

  for (const key of REDIRECT_QUERY_KEYS) {
    const nestedURL = parsed.searchParams.get(key);
    if (nestedURL && parseHttpUrl(nestedURL) && isAdSearchResultUrl(nestedURL)) return true;
  }

  return false;
}

function isAdSearchResult(result: SearchResult): boolean {
  if (isAdSearchResultUrl(result.url)) return true;
  const combinedText = `${result.title} ${result.snippet}`.toLowerCase();
  return /\b(sponsored|advertisement|promoted result|exclusive discounts|limited-time offer)\b/.test(
    combinedText,
  );
}

function isCommerceQuery(query: string): boolean {
  return /\b(buy|price|coupon|discount|deal|sale|review|best|cheap|shopping|product)\b/i.test(
    query,
  );
}

function isSpammySearchResult(result: SearchResult, query: string): boolean {
  if (isCommerceQuery(query)) return false;
  const combinedText = `${result.title} ${result.snippet}`.toLowerCase();
  if (
    /\b(coupon code|promo code|exclusive deal|limited-time offer|best price|shop now|buy now|sale ends|discount code|cashback|affiliate disclosure)\b/i.test(
      combinedText,
    )
  ) {
    return true;
  }

  try {
    const parsed = new URL(result.url);
    const hostAndPath = `${parsed.hostname}${parsed.pathname}`;
    return SPAM_HOST_PATTERNS.some((pattern) => pattern.test(hostAndPath));
  } catch {
    return true;
  }
}

function resultHost(rawURL: string): string | null {
  try {
    return new URL(rawURL).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function passesDomainFilters(result: SearchResult, filters: SearchFilters): boolean {
  const host = resultHost(result.url);
  if (filters.includeDomains.length > 0) {
    if (!host) return false;
    if (!filters.includeDomains.some((d) => hostMatchesDomain(host, d))) return false;
  }
  if (filters.excludeDomains.length > 0) {
    if (host && filters.excludeDomains.some((d) => hostMatchesDomain(host, d))) return false;
  }
  return true;
}

function emptyFilterStats(): FilterStats {
  return { ads: 0, spam: 0, duplicates: 0, domainFiltered: 0 };
}

function filterSearchResults(
  results: SearchResult[],
  maxResults: number,
  filters: SearchFilters,
  query: string,
): FilteredResults {
  const filtered: SearchResult[] = [];
  const seenUrls = new Set<string>();
  const stats = emptyFilterStats();

  for (const result of results) {
    const canonicalUrl = canonicalSearchResultUrl(result.url);
    if (!canonicalUrl || isAdSearchResult({ ...result, url: canonicalUrl })) {
      stats.ads++;
      continue;
    }

    const normalizedResult = { ...result, url: canonicalUrl };
    if (isSpammySearchResult(normalizedResult, query)) {
      stats.spam++;
      continue;
    }

    if (!passesDomainFilters(normalizedResult, filters)) {
      stats.domainFiltered++;
      continue;
    }

    if (seenUrls.has(canonicalUrl)) {
      stats.duplicates++;
      continue;
    }

    seenUrls.add(canonicalUrl);
    filtered.push(normalizedResult);
    if (filtered.length >= maxResults) break;
  }

  return { results: filtered, stats };
}

// ── Request building ─────────────────────────────────────

/** Build the `site:`/`-site:` clauses appended to the query for domain scoping. */
function domainScopeSuffix(filters: SearchFilters): string {
  if (filters.includeDomains.length > 0) {
    return " " + filters.includeDomains.map((d) => `site:${d}`).join(" OR ");
  }
  if (filters.excludeDomains.length > 0) {
    return " " + filters.excludeDomains.map((d) => `-site:${d}`).join(" ");
  }
  return "";
}

const GOOGLE_QDR: Record<TimeRange, string> = { day: "d", week: "w", month: "m", year: "y" };
const DDG_DF: Record<TimeRange, string> = { day: "d", week: "w", month: "m", year: "y" };
const BING_FILTER: Partial<Record<TimeRange, string>> = {
  day: 'ex1:"ez1"',
  week: 'ex1:"ez2"',
  month: 'ex1:"ez3"',
};

function buildRequest(engine: SearchEngine, query: string, filters: SearchFilters) {
  const scopedQuery = query + domainScopeSuffix(filters);
  const encoded = encodeURIComponent(scopedQuery);
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const time = filters.timeRange;

  const headers: Record<string, string> = {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  let url: string;
  let method = "GET";
  let body: string | undefined;

  switch (engine) {
    case "DuckDuckGo":
      url = `https://html.duckduckgo.com/html/?q=${encoded}`;
      if (time) url += `&df=${DDG_DF[time]}`;
      break;
    case "DuckDuckGoLite": {
      url = "https://lite.duckduckgo.com/lite/";
      method = "POST";
      const params = new URLSearchParams({ q: scopedQuery });
      if (time) params.set("df", DDG_DF[time]);
      body = params.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      break;
    }
    case "Brave":
      // Brave has no reliable recency URL param; domain scoping applies via site:.
      url = `https://search.brave.com/search?q=${encoded}&source=web`;
      headers.Accept = "text/html";
      break;
    case "Bing":
      url = `https://www.bing.com/search?q=${encoded}`;
      if (time && BING_FILTER[time]) {
        url += `&filters=${encodeURIComponent(BING_FILTER[time] as string)}`;
      }
      headers.Accept = "text/html";
      break;
    case "Google":
      url = `https://www.google.com/search?q=${encoded}&hl=en`;
      if (time) url += `&tbs=qdr:${GOOGLE_QDR[time]}`;
      break;
  }

  return { url, headers, method, body };
}

// ── Fetch with retry ─────────────────────────────────────

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  method = "GET",
  body?: string,
  maxRetries = 3,
): Promise<{ data: string; statusCode: number }> {
  let lastError: Error = new Error("No attempts made");

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const baseDelay = Math.pow(2, attempt - 1) * 1000;
      const jitter = 1 + Math.random() * 0.5;
      await new Promise((r) => setTimeout(r, baseDelay * jitter));
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      const text = await response.text();
      return { data: text, statusCode: response.status };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
}

// ── Rate limit detection ─────────────────────────────────

function isRateLimited(statusCode: number, html: string): boolean {
  if ([429, 403, 503].includes(statusCode)) return true;
  const lower = html.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

// ── Parsers ──────────────────────────────────────────────

function getAttributeValue(html: string, attribute: string): string {
  const match = html.match(new RegExp(`${attribute}=["']([^"']+)["']`, "i"));
  return match?.[1] ?? "";
}

function isSponsoredBlock(html: string): boolean {
  const text = cleanHTML(html);
  return (
    /\b(Sponsored|Ads?|Promoted)\b/i.test(text) ||
    /\b(b_ad|b_adlabel|uEierd|pla-unit|commercial-unit-desktop-top)\b/i.test(html) ||
    /(?:class|id|aria-label|data-testid|data-text-ad)=['"][^'"]*\b(?:ad|ads|sponsored|promoted)\b/i.test(
      html,
    )
  );
}

function parseDDGResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRegex =
    /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bresult\b|<\/body>|$)/g;
  const fallbackLinkRegex =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;

  for (const block of html.matchAll(blockRegex)) {
    const blockHTML = block[1];
    if (isSponsoredBlock(blockHTML)) continue;
    const linkMatch = blockHTML.match(
      /<a[^>]*class="[^"]*(?:result__a|result__title)[^"]*"[^>]*>[\s\S]*?<\/a>/i,
    );
    if (!linkMatch) continue;

    const rawLink = linkMatch[0];
    const rawURL = getAttributeValue(rawLink, "href");
    const title = cleanHTML(rawLink);
    const snippetMatch = blockHTML.match(
      /<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i,
    );
    const snippet = snippetMatch ? cleanHTML(snippetMatch[1]) : "";
    const unwrappedURL = unwrapDDGRedirect(rawURL);
    const url = canonicalSearchResultUrl(unwrappedURL) ?? unwrappedURL;

    if (url && title) {
      results.push({ title, url, snippet });
    }
  }

  if (results.length > 0) return results;

  for (const link of html.matchAll(fallbackLinkRegex)) {
    const [linkHTML, rawURL, rawTitle] = link;
    if (isSponsoredBlock(linkHTML)) continue;
    const unwrappedURL = unwrapDDGRedirect(rawURL);
    const url = canonicalSearchResultUrl(unwrappedURL) ?? unwrappedURL;
    const title = cleanHTML(rawTitle);
    if (url && title) {
      results.push({ title, url, snippet: "" });
    }
  }

  return results;
}

function unwrapDDGRedirect(rawURL: string): string {
  if (rawURL.includes("uddg=")) {
    try {
      const params = new URL(rawURL, "https://duckduckgo.com").searchParams;
      const uddg = params.get("uddg");
      if (uddg) return uddg;
    } catch {
      // fall through
    }
  }
  if (rawURL.startsWith("//")) return "https:" + rawURL;
  return rawURL;
}

function unwrapBingRedirect(rawURL: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawURL, "https://www.bing.com");
  } catch {
    return rawURL;
  }

  const encodedURL = parsed.searchParams.get("u");
  if (!encodedURL) return parsed.href;

  try {
    const base64URL = encodedURL.startsWith("a1") ? encodedURL.slice(2) : encodedURL;
    return Buffer.from(base64URL, "base64url").toString("utf8");
  } catch {
    return parsed.href;
  }
}

function parseBraveResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRegex = /<div[^>]*class="snippet[^"]*"[^>]*>(.*?)<\/div>\s*<\/div>/gs;
  const linkRegex = /<a[^>]*href="([^"]*)"[^>]*class="[^"]*result-header[^"]*"[^>]*>(.*?)<\/a>/s;
  const descRegex = /<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>(.*?)<\/p>/s;

  for (const block of html.matchAll(blockRegex)) {
    const blockHTML = block[1];
    if (isSponsoredBlock(blockHTML)) continue;
    const linkMatch = blockHTML.match(linkRegex);
    if (!linkMatch) continue;

    const rawURL = linkMatch[1];
    const url = canonicalSearchResultUrl(rawURL) ?? rawURL;
    const title = cleanHTML(linkMatch[2]);
    const descMatch = blockHTML.match(descRegex);
    const snippet = descMatch ? cleanHTML(descMatch[1]) : "";

    if (url && title) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function parseBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRegex =
    /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?[\s\S]*?<\/li>/g;

  for (const block of html.matchAll(blockRegex)) {
    const [blockHTML, rawURL, rawTitle, rawSnippet = ""] = block;
    if (isSponsoredBlock(blockHTML)) continue;
    const unwrappedURL = unwrapBingRedirect(decodeHTMLEntities(rawURL));
    const url = canonicalSearchResultUrl(unwrappedURL) ?? unwrappedURL;
    const title = cleanHTML(rawTitle);
    const snippet = cleanHTML(rawSnippet);

    if (url && title) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function unwrapGoogleRedirect(rawURL: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawURL, "https://www.google.com");
  } catch {
    return rawURL;
  }

  if (parsed.pathname === "/url") {
    const resultURL = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
    if (resultURL) return resultURL;
  }

  return parsed.href;
}

function parseGoogleResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRegex =
    /<div[^>]*class="[^"]*\bg\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bg\b|<\/body>|$)/g;
  const fallbackBlockRegex =
    /<div[^>]*data-hveid="[^"]+"[^>]*>([\s\S]*?)(?=<div[^>]*data-hveid="[^"]+"|<\/body>|$)/g;

  for (const regex of [blockRegex, fallbackBlockRegex]) {
    for (const block of html.matchAll(regex)) {
      const blockHTML = block[1];
      if (isSponsoredBlock(blockHTML)) continue;
      const titleMatch = blockHTML.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      const linkMatch = blockHTML.match(/<a[^>]*href="([^"]+)"[^>]*>/i);
      if (!titleMatch || !linkMatch) continue;

      const snippetMatch = blockHTML.match(
        /<div[^>]*(?:class="[^"]*(?:VwiC3b|yDYNvb)[^"]*"|data-sncf="[^"]*")[^>]*>([\s\S]*?)<\/div>/i,
      );
      const unwrappedURL = unwrapGoogleRedirect(decodeHTMLEntities(linkMatch[1]));
      const url = canonicalSearchResultUrl(unwrappedURL) ?? unwrappedURL;
      const title = cleanHTML(titleMatch[1]);
      const snippet = snippetMatch ? cleanHTML(snippetMatch[1]) : "";

      if (url && title) {
        results.push({ title, url, snippet });
      }
    }

    if (results.length > 0) break;
  }

  return results;
}

// ── Search cascade ───────────────────────────────────────

async function performSearch(
  query: string,
  maxResults: number,
  filters: SearchFilters,
  signal: AbortSignal,
): Promise<{ results: SearchResult[]; engine: SearchEngine; stats: FilterStats }> {
  for (const engine of ENGINES) {
    try {
      const { url, headers, method, body } = buildRequest(engine, query, filters);
      const { data: html, statusCode } = await fetchWithRetry(url, headers, signal, method, body);

      if (isRateLimited(statusCode, html)) continue;

      let results: SearchResult[];
      switch (engine) {
        case "DuckDuckGo":
        case "DuckDuckGoLite":
          results = parseDDGResults(html);
          break;
        case "Brave":
          results = parseBraveResults(html);
          break;
        case "Bing":
          results = parseBingResults(html);
          break;
        case "Google":
          results = parseGoogleResults(html);
          break;
      }

      const filteredResults = filterSearchResults(results, maxResults, filters, query);
      if (filteredResults.results.length > 0) {
        return { results: filteredResults.results, engine, stats: filteredResults.stats };
      }
    } catch {
      // try next engine
    }
  }

  return { results: [], engine: "DuckDuckGo", stats: emptyFilterStats() };
}

// ── Tool definition ──────────────────────────────────────

const parameters = z
  .object({
    query: z.string().describe("Search query"),
    max_results: z.number().optional().describe("Max results to return (default: 5, max: 20)"),
    include_domains: z
      .array(z.string())
      .optional()
      .describe("Only return results from these domains (mutually exclusive with exclude_domains)"),
    exclude_domains: z
      .array(z.string())
      .optional()
      .describe("Drop results from these domains (mutually exclusive with include_domains)"),
    time_range: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("Restrict results to a recency window"),
  })
  .refine((v) => !(v.include_domains?.length && v.exclude_domains?.length), {
    message: "include_domains and exclude_domains are mutually exclusive.",
  });

function filtersFooter(filters: SearchFilters): string {
  const parts: string[] = [];
  if (filters.includeDomains.length > 0) parts.push(`site:${filters.includeDomains.join(",")}`);
  if (filters.excludeDomains.length > 0) parts.push(`-site:${filters.excludeDomains.join(",")}`);
  if (filters.timeRange) parts.push(`past ${filters.timeRange}`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function statsFooter(stats: FilterStats): string {
  const parts: string[] = [];
  if (stats.ads > 0) parts.push(`filtered ${stats.ads} ad${stats.ads === 1 ? "" : "s"}`);
  if (stats.spam > 0)
    parts.push(`filtered ${stats.spam} spam result${stats.spam === 1 ? "" : "s"}`);
  if (stats.duplicates > 0)
    parts.push(`${stats.duplicates} duplicate${stats.duplicates === 1 ? "" : "s"}`);
  if (stats.domainFiltered > 0) {
    parts.push(`filtered ${stats.domainFiltered} by domain`);
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

export function createWebSearchTool(): AgentTool<typeof parameters> {
  return {
    name: "web_search",
    description:
      "Search the web and return results. Use for current information, recent events, or facts " +
      "beyond your knowledge cutoff. Supports include_domains / exclude_domains scoping (mutually " +
      "exclusive) and a time_range recency filter (day|week|month|year).",
    parameters,
    async execute(args, context) {
      const maxResults = Math.min(args.max_results ?? 5, 20);

      const filters: SearchFilters = {
        includeDomains: normalizeDomains(args.include_domains),
        excludeDomains: normalizeDomains(args.exclude_domains),
        ...(args.time_range ? { timeRange: args.time_range } : {}),
      };

      const { results, engine, stats } = await performSearch(
        args.query,
        maxResults,
        filters,
        context.signal,
      );

      if (results.length === 0) {
        return `No search results found for: "${args.query}". All search engines were unavailable or returned no results.`;
      }

      let output = `Web search results for: "${args.query}"\n\n`;
      for (let i = 0; i < results.length; i++) {
        output += `${i + 1}. [${results[i].title}](${results[i].url})\n`;
        if (results[i].snippet) {
          output += `   ${results[i].snippet}\n`;
        }
        output += "\n";
      }
      output += `(${results.length} results from ${engine}${statsFooter(stats)}${filtersFooter(filters)})`;

      return output;
    },
  };
}
