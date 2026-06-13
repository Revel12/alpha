import { Buffer } from "node:buffer";

export interface SearchInput {
  pattern: string;
  paths: string[];
  regex: boolean;
  caseSensitive: boolean;
  gitignore: boolean;
  skip: number;
  contextBefore: number;
  contextAfter: number;
  maxResults: number;
}

export interface SearchDefaults {
  regex?: boolean;
  caseSensitive?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  maxResults?: number;
}

export interface SearchLine {
  lineNumber: number;
  text: string;
  match: boolean;
}

export interface SearchFileResult {
  path: string;
  tag: string;
  matchCount: number;
  lines: SearchLine[];
}

export interface SearchRenderResult {
  text: string;
  matchCount: number;
  fileCount: number;
  limited: boolean;
}

type RawSearchInput = Partial<Omit<SearchInput, "pattern" | "paths">> & {
  pattern?: unknown;
  query?: unknown;
  paths?: unknown;
  path?: unknown;
  glob?: unknown;
  i?: unknown;
};

export function parseSearchInput(args: string, defaults: SearchDefaults = {}): SearchInput {
  const trimmed = args.trim();
  let raw: RawSearchInput;

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as RawSearchInput;
    raw = parsed;
  } else {
    raw = { query: trimmed };
  }

  const pattern = typeof raw.pattern === "string" ? raw.pattern : typeof raw.query === "string" ? raw.query : "";
  if (!pattern.trim()) throw new Error("search requires a pattern.");

  return {
    pattern,
    paths: normalizePaths(raw),
    regex: typeof raw.regex === "boolean" ? raw.regex : defaults.regex ?? true,
    caseSensitive: typeof raw.caseSensitive === "boolean" ? raw.caseSensitive : raw.i === true ? false : defaults.caseSensitive ?? true,
    gitignore: typeof raw.gitignore === "boolean" ? raw.gitignore : true,
    skip: clampInteger(raw.skip, 0, 0, 100000),
    contextBefore: clampInteger(raw.contextBefore, defaults.contextBefore ?? 1, 0, 20),
    contextAfter: clampInteger(raw.contextAfter, defaults.contextAfter ?? 1, 0, 20),
    maxResults: clampInteger(raw.maxResults, defaults.maxResults ?? 80, 1, 5000),
  };
}

export function includeGlobsForSearch(input: Pick<SearchInput, "paths">): string[] {
  if (input.paths.length === 0) return ["**/*"];
  return input.paths.map(pathEntryToGlob);
}

export function includeGlobForSearch(input: { path?: string; glob?: string }): string {
  return includeGlobsForSearch({
    paths: input.glob ? [input.glob] : input.path ? [input.path] : [],
  })[0];
}

function pathEntryToGlob(pathEntry: string): string {
  const normalized = pathEntry.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized === ".") return "**/*";
  if (hasGlobSyntax(normalized)) return normalized;
  if (/\/[^/]+\.[^/]+$/.test(`/${normalized}`)) return normalized;
  return `${normalized}/**/*`;
}

export function searchText(path: string, tag: string, content: string, input: SearchInput, remainingMatches: number): SearchFileResult | undefined {
  if (content.includes("\u0000")) return undefined;

  const matcher = buildMatcher(input);
  const sourceLines = content.split(/\r?\n/);
  const lineKinds = new Map<number, boolean>();
  let matchCount = 0;

  for (let index = 0; index < sourceLines.length && matchCount < remainingMatches; index++) {
    if (!matcher(sourceLines[index])) continue;
    matchCount++;
    const start = Math.max(0, index - input.contextBefore);
    const end = Math.min(sourceLines.length - 1, index + input.contextAfter);
    for (let ctx = start; ctx <= end; ctx++) {
      lineKinds.set(ctx, lineKinds.get(ctx) === true || ctx === index);
    }
  }

  if (matchCount === 0) return undefined;

  const lines = [...lineKinds.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, match]) => ({
      lineNumber: index + 1,
      text: sourceLines[index],
      match,
    }));

  return { path, tag, matchCount, lines };
}

export function renderSearchResults(results: SearchFileResult[], input: Pick<SearchInput, "pattern" | "maxResults">, limited: boolean): SearchRenderResult {
  const matchCount = results.reduce((sum, result) => sum + result.matchCount, 0);
  const fileCount = results.length;

  if (matchCount === 0) {
    return {
      text: `No matches found for ${JSON.stringify(input.pattern)}.`,
      matchCount,
      fileCount,
      limited: false,
    };
  }

  const lines = [`Search found ${matchCount} ${plural("match", matchCount)} in ${fileCount} ${plural("file", fileCount)} for ${JSON.stringify(input.pattern)}.`];

  for (const result of results) {
    lines.push("", `[${result.path}#${result.tag}]`, "```text");
    let lastLine = 0;
    for (const line of result.lines) {
      if (lastLine !== 0 && line.lineNumber > lastLine + 1) lines.push("...");
      lines.push(`${line.match ? "*" : " "}${line.lineNumber}:${line.text}`);
      lastLine = line.lineNumber;
    }
    lines.push("```");
  }

  if (limited) {
    lines.push("", `Limited to the first ${input.maxResults} ${plural("match", input.maxResults)}. Narrow the query or path for exhaustive results.`);
  }

  return {
    text: lines.join("\n"),
    matchCount,
    fileCount,
    limited,
  };
}

export function truncateSearchOutput(output: string, maxVisibleBytes: number): { visible: string; truncated: boolean } {
  if (Buffer.byteLength(output, "utf8") <= maxVisibleBytes) {
    return { visible: output, truncated: false };
  }

  const marker = "\n\n[search output truncated; full output stored as artifact]";
  const budget = Math.max(0, maxVisibleBytes - Buffer.byteLength(marker, "utf8"));
  const visible = Buffer.from(output, "utf8").subarray(0, budget).toString("utf8").replace(/\uFFFD$/u, "");
  return { visible: `${visible}${marker}`, truncated: true };
}

function buildMatcher(input: SearchInput): (line: string) => boolean {
  if (!input.regex) {
    const needle = input.caseSensitive ? input.pattern : input.pattern.toLowerCase();
    return (line) => (input.caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, input.caseSensitive ? "" : "i");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid search regex: ${message}`);
  }

  return (line) => regex.test(line);
}

function normalizePaths(raw: RawSearchInput): string[] {
  const fromPaths = raw.paths;
  if (typeof fromPaths === "string" && fromPaths.trim()) return [fromPaths.trim()];
  if (Array.isArray(fromPaths)) {
    return fromPaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }
  if (typeof raw.glob === "string" && raw.glob.trim()) return [raw.glob.trim()];
  if (typeof raw.path === "string" && raw.path.trim()) return [raw.path.trim()];
  return [];
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

function hasGlobSyntax(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
