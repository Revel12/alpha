export type WebSearchRecency = "day" | "week" | "month" | "year";

export interface WebSearchInput {
  query: string;
  recency?: WebSearchRecency;
  limit?: number;
  max_tokens?: number;
  temperature?: number;
  num_search_results?: number;
}

export interface WebSearchSource {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchResponse {
  provider: "duckduckgo_html" | "none";
  sources: WebSearchSource[];
  searchQueries?: string[];
  error?: string;
}

export function parseWebSearchInput(input: unknown): WebSearchInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("web_search expects an object input.");
  }
  const record = input as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (!query) throw new Error("query is required.");

  const recency = parseRecency(record.recency);
  const limit = clampCount(numberValue(record.limit) ?? numberValue(record.num_search_results) ?? 10, 1, 20);
  const numSearchResults = clampCount(numberValue(record.num_search_results) ?? limit, 1, 20);

  return {
    query,
    ...(recency ? { recency } : {}),
    limit,
    ...(typeof record.max_tokens === "number" ? { max_tokens: record.max_tokens } : {}),
    ...(typeof record.temperature === "number" ? { temperature: record.temperature } : {}),
    num_search_results: numSearchResults,
  };
}

export function duckDuckGoHtmlUrl(input: WebSearchInput): string {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", input.query);
  const df = recencyParam(input.recency);
  if (df) url.searchParams.set("df", df);
  return url.toString();
}

export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchSource[] {
  const results: WebSearchSource[] = [];
  const blocks = html.match(/<div\b[^>]*class=["'][^"']*(?:result|web-result)[^"']*["'][\s\S]*?(?=<div\b[^>]*class=["'][^"']*(?:result|web-result)[^"']*["']|<\/body>|$)/gi) ?? [];
  for (const block of blocks) {
    if (results.length >= limit) break;
    const link = firstMatch(block, /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      ?? firstMatch(block, /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i)
      ?? firstMatch(block, /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;

    const url = unwrapDuckDuckGoUrl(link[1] ?? "");
    if (!/^https?:\/\//i.test(url)) continue;
    const title = cleanInlineText(link[2] ?? "") || url;
    const snippetHtml = firstGroup(block, /<a\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
      ?? firstGroup(block, /<div\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
      ?? firstGroup(block, /<span\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const snippet = cleanInlineText(snippetHtml ?? "");
    results.push({ title, url, ...(snippet ? { snippet } : {}) });
  }
  return results;
}

export function formatWebSearchForLlm(response: WebSearchResponse): string {
  if (response.error) return `Error: ${response.error}`;
  const parts: string[] = [];
  for (const [index, source] of response.sources.entries()) {
    parts.push(`[${index + 1}] ${source.title}\n    ${source.url}`);
    if (source.snippet) parts.push(`    ${truncateText(source.snippet, 240)}`);
  }
  if (response.searchQueries?.length) {
    parts.push(`Search queries: ${response.searchQueries.length}`);
    for (const query of response.searchQueries.slice(0, 3)) {
      parts.push(`- ${truncateText(query, 120)}`);
    }
  }
  return parts.length ? parts.join("\n") : "No search results.";
}

export function cleanInlineText(input: string): string {
  return htmlDecode(stripHtmlTags(input)).replace(/\s+/g, " ").trim();
}

export function htmlDecode(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'");
}

function parseRecency(value: unknown): WebSearchRecency | undefined {
  return value === "day" || value === "week" || value === "month" || value === "year" ? value : undefined;
}

function recencyParam(recency: WebSearchRecency | undefined): string | undefined {
  if (recency === "day") return "d";
  if (recency === "week") return "w";
  if (recency === "month") return "m";
  if (recency === "year") return "y";
  return undefined;
}

function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href, "https://duckduckgo.com");
    if (url.hostname.endsWith("duckduckgo.com") && url.pathname.startsWith("/l/")) {
      const target = url.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    }
    return url.href;
  } catch {
    return href;
  }
}

function stripHtmlTags(input: string): string {
  return input.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ");
}

function firstMatch(input: string, pattern: RegExp): RegExpMatchArray | undefined {
  return input.match(pattern) ?? undefined;
}

function firstGroup(input: string, pattern: RegExp): string | undefined {
  return input.match(pattern)?.[1];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampCount(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.floor(value), max));
}

function truncateText(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, Math.max(0, maxLen - 1))}...`;
}
