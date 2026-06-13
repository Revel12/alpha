import { Buffer } from "node:buffer";
import * as path from "node:path";

export interface FindInput {
  paths: string[];
  hidden: boolean;
  gitignore: boolean;
  limit: number;
  timeout: number;
}

export interface FindEntry {
  path: string;
  mtime: number;
}

export interface FindRenderResult {
  text: string;
  count: number;
  limited: boolean;
}

type RawFindInput = {
  paths?: unknown;
  glob?: unknown;
  hidden?: unknown;
  gitignore?: unknown;
  limit?: unknown;
  timeout?: unknown;
};

export function parseFindInput(args: string): FindInput {
  const trimmed = args.trim();
  const raw: RawFindInput = trimmed.startsWith("{") ? JSON.parse(trimmed) as RawFindInput : { paths: trimmed ? [trimmed] : ["**/*"] };
  const paths = normalizePaths(raw);
  if (paths.length === 0) throw new Error("find requires at least one path or glob.");

  return {
    paths,
    hidden: typeof raw.hidden === "boolean" ? raw.hidden : true,
    gitignore: typeof raw.gitignore === "boolean" ? raw.gitignore : true,
    limit: clampNumber(raw.limit, 200, 1, 200),
    timeout: clampNumber(raw.timeout, 5, 0.5, 60),
  };
}

export function findIncludeGlobs(input: Pick<FindInput, "paths">): string[] {
  return input.paths.map(pathToIncludeGlob);
}

export function findExcludeGlob(input: Pick<FindInput, "hidden">): string {
  const excludes = ["node_modules", "out", "dist", "build", ".git", "coverage", "target", "vendor"];
  if (!input.hidden) excludes.push(".*");
  return `**/{${excludes.join(",")}}/**`;
}

export function matchesFindGlob(candidate: string, glob: string): boolean {
  const normalizedCandidate = normalizeOutputPath(candidate).replace(/\/$/, "");
  const normalizedGlob = normalizeOutputPath(glob).replace(/\/$/, "");
  return globToRegex(normalizedGlob).test(normalizedCandidate);
}

export function mergeFindEntries(entries: FindEntry[], limit: number): { entries: string[]; limited: boolean } {
  const seen = new Set<string>();
  const merged: FindEntry[] = [];
  for (const entry of entries) {
    const normalized = normalizeOutputPath(entry.path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push({ ...entry, path: normalized });
  }

  merged.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  return {
    entries: merged.slice(0, limit).map((entry) => entry.path),
    limited: merged.length > limit,
  };
}

export function renderFindResults(paths: string[], opts: { limited: boolean; limit: number; notice?: string }): FindRenderResult {
  if (paths.length === 0) {
    return {
      text: ["No files found matching pattern", opts.notice].filter(Boolean).join("\n"),
      count: 0,
      limited: opts.limited,
    };
  }

  const lines = formatGroupedPaths(paths);
  if (opts.limited) lines.push("", `Limited to the first ${opts.limit} results. Narrow paths or raise timeout for a better page.`);
  if (opts.notice) lines.push("", opts.notice);
  return {
    text: lines.join("\n"),
    count: paths.length,
    limited: opts.limited,
  };
}

export function truncateFindOutput(output: string, maxVisibleBytes: number): { visible: string; truncated: boolean } {
  if (Buffer.byteLength(output, "utf8") <= maxVisibleBytes) return { visible: output, truncated: false };

  const marker = "\n\n[find output truncated; full output stored as artifact]";
  const budget = Math.max(0, maxVisibleBytes - Buffer.byteLength(marker, "utf8"));
  const visible = Buffer.from(output, "utf8").subarray(0, budget).toString("utf8").replace(/\uFFFD$/u, "");
  return { visible: `${visible}${marker}`, truncated: true };
}

function normalizePaths(raw: RawFindInput): string[] {
  if (Array.isArray(raw.paths)) {
    return raw.paths.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }
  if (typeof raw.paths === "string" && raw.paths.trim()) return [raw.paths.trim()];
  if (typeof raw.glob === "string" && raw.glob.trim()) return [raw.glob.trim()];
  return [];
}

function pathToIncludeGlob(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized === ".") return "**/*";
  if (hasGlobSyntax(normalized)) return normalized;
  if (/\/[^/]+\.[^/]+$/.test(`/${normalized}`)) return normalized;
  return `${normalized}/**/*`;
}

function formatGroupedPaths(entries: string[]): string[] {
  const rootEntries: string[] = [];
  const groups = new Map<string, string[]>();

  for (const entry of entries) {
    const normalized = normalizeOutputPath(entry);
    const dirname = path.posix.dirname(normalized);
    const basename = path.posix.basename(normalized) + (normalized.endsWith("/") && !path.posix.basename(normalized).endsWith("/") ? "/" : "");
    if (dirname === ".") {
      rootEntries.push(normalized);
      continue;
    }
    const header = dirname.endsWith("/") ? dirname : `${dirname}/`;
    groups.set(header, [...(groups.get(header) ?? []), basename]);
  }

  const lines = [...rootEntries];
  for (const [dirname, basenames] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (lines.length > 0) lines.push("");
    lines.push(`# ${dirname}`);
    lines.push(...basenames);
  }
  return lines;
}

function normalizeOutputPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}

function hasGlobSyntax(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function globToRegex(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*" && glob[index + 2] === "/") {
      pattern += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      pattern += ".*";
      index++;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegex(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
