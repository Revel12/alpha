export type ConflictScope = "ours" | "theirs" | "base";

export interface ConflictBlock {
  path: string;
  displayPath: string;
  startLine: number;
  separatorLine: number;
  endLine: number;
  oursLabel?: string;
  theirsLabel?: string;
  baseLabel?: string;
  baseLine?: number;
  oursLines: string[];
  theirsLines: string[];
  baseLines?: string[];
}

export interface ConflictEntry extends ConflictBlock {
  id: number;
}

export interface ParsedConflictUri {
  id: number | "*";
  scope?: ConflictScope;
  recoveredPrefix?: string;
}

export interface ConflictStore {
  register(conflict: Omit<ConflictEntry, "id">): ConflictEntry;
  get(id: number): ConflictEntry | undefined;
  remove(id: number): void;
  entries(): ConflictEntry[];
  clear(): void;
}

const OURS_PREFIX = "<<<<<<<";
const BASE_PREFIX = "|||||||";
const SEPARATOR = "=======";
const THEIRS_PREFIX = ">>>>>>>";
const CONFLICT_SCOPES = new Set<ConflictScope>(["ours", "theirs", "base"]);
const CONFLICT_URI_RE = /^(?:(.+):)?conflict:\/\/(.+)$/;

export function parseConflictUri(raw: string): ParsedConflictUri | null {
  const match = raw.match(CONFLICT_URI_RE);
  if (!match) return null;
  const recoveredPrefix = match[1];
  const tail = match[2] ?? "";
  const slashIdx = tail.indexOf("/");
  const idPart = slashIdx === -1 ? tail : tail.slice(0, slashIdx);
  const scopePart = slashIdx === -1 ? undefined : tail.slice(slashIdx + 1);

  if (idPart === "*") {
    if (scopePart !== undefined) {
      throw new Error(`Invalid conflict URI '${raw}': wildcard 'conflict://*' does not accept a scope segment.`);
    }
    return recoveredPrefix !== undefined ? { id: "*", recoveredPrefix } : { id: "*" };
  }

  if (!/^\d+$/.test(idPart)) {
    throw new Error(`Invalid conflict URI '${raw}': must be 'conflict://<N>', 'conflict://<N>/<scope>', or 'conflict://*'.`);
  }
  const id = Number.parseInt(idPart, 10);
  if (!Number.isFinite(id) || id < 1) {
    throw new Error(`Invalid conflict URI '${raw}': id must be >= 1.`);
  }

  let scope: ConflictScope | undefined;
  if (scopePart !== undefined) {
    if (!CONFLICT_SCOPES.has(scopePart as ConflictScope)) {
      throw new Error(`Invalid conflict URI '${raw}': scope must be one of 'ours', 'theirs', 'base', or omitted.`);
    }
    scope = scopePart as ConflictScope;
  }

  return {
    id,
    ...(scope === undefined ? {} : { scope }),
    ...(recoveredPrefix === undefined ? {} : { recoveredPrefix }),
  };
}

export class InMemoryConflictStore implements ConflictStore {
  private conflicts = new Map<number, ConflictEntry>();
  private nextId = 1;

  constructor(initial: ConflictEntry[] = [], private readonly onChange: () => void = () => undefined) {
    for (const entry of initial) {
      this.conflicts.set(entry.id, cloneEntry(entry));
      if (entry.id >= this.nextId) this.nextId = entry.id + 1;
    }
  }

  register(conflict: Omit<ConflictEntry, "id">): ConflictEntry {
    for (const existing of this.conflicts.values()) {
      if (conflictRegionsEqual(existing, conflict) && existing.path === conflict.path) {
        const merged = { ...cloneEntry(conflict), id: existing.id };
        this.conflicts.set(existing.id, merged);
        this.onChange();
        return cloneEntry(merged);
      }
    }
    const entry = { ...cloneEntry(conflict), id: this.nextId++ };
    this.conflicts.set(entry.id, entry);
    this.onChange();
    return cloneEntry(entry);
  }

  get(id: number): ConflictEntry | undefined {
    const entry = this.conflicts.get(id);
    return entry ? cloneEntry(entry) : undefined;
  }

  remove(id: number): void {
    if (this.conflicts.delete(id)) this.onChange();
  }

  entries(): ConflictEntry[] {
    return [...this.conflicts.values()].map(cloneEntry).sort((left, right) => left.id - right.id);
  }

  clear(): void {
    if (this.conflicts.size === 0) return;
    this.conflicts.clear();
    this.onChange();
  }
}

export function scanConflictLines(lines: readonly string[], firstLineNumber: number, path = "", displayPath = path): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const oursLabel = markerLabel(lines[index], OURS_PREFIX);
    if (oursLabel === undefined) {
      index++;
      continue;
    }

    const startIndex = index;
    const oursLines: string[] = [];
    const baseLines: string[] = [];
    const theirsLines: string[] = [];
    let baseLabel: string | undefined;
    let baseLine: number | undefined;
    let separatorIndex = -1;
    let endIndex = -1;
    index++;

    for (; index < lines.length; index++) {
      const line = stripTrailingCr(lines[index] ?? "");
      const currentBaseLabel = markerLabel(line, BASE_PREFIX);
      if (currentBaseLabel !== undefined && separatorIndex === -1) {
        baseLabel = currentBaseLabel;
        baseLine = firstLineNumber + index;
        index++;
        break;
      }
      if (line === SEPARATOR) {
        separatorIndex = index;
        index++;
        break;
      }
      oursLines.push(line);
    }

    if (baseLine !== undefined) {
      for (; index < lines.length; index++) {
        const line = stripTrailingCr(lines[index] ?? "");
        if (line === SEPARATOR) {
          separatorIndex = index;
          index++;
          break;
        }
        baseLines.push(line);
      }
    }

    if (separatorIndex === -1) {
      index = startIndex + 1;
      continue;
    }

    let theirsLabel: string | undefined;
    for (; index < lines.length; index++) {
      const line = stripTrailingCr(lines[index] ?? "");
      const label = markerLabel(line, THEIRS_PREFIX);
      if (label !== undefined) {
        theirsLabel = label;
        endIndex = index;
        index++;
        break;
      }
      theirsLines.push(line);
    }

    if (endIndex === -1) {
      index = startIndex + 1;
      continue;
    }

    blocks.push({
      path,
      displayPath,
      startLine: firstLineNumber + startIndex,
      separatorLine: firstLineNumber + separatorIndex,
      endLine: firstLineNumber + endIndex,
      oursLabel,
      theirsLabel,
      baseLabel,
      baseLine,
      oursLines,
      theirsLines,
      baseLines: baseLine === undefined ? undefined : baseLines,
    });
  }
  return blocks;
}

export function registerConflicts(store: ConflictStore, blocks: readonly ConflictBlock[]): ConflictEntry[] {
  return blocks.map((block) => store.register(block));
}

export function renderConflictRegion(entry: ConflictEntry, scope?: ConflictScope): { lines: string[]; startLine: number } {
  if (scope === "ours") return { lines: [...entry.oursLines], startLine: entry.startLine + 1 };
  if (scope === "theirs") return { lines: [...entry.theirsLines], startLine: entry.separatorLine + 1 };
  if (scope === "base") {
    if (entry.baseLines === undefined || entry.baseLine === undefined) {
      throw new Error(`Conflict #${entry.id} has no base section. 'conflict://${entry.id}/base' is only valid for diff3 conflicts.`);
    }
    return { lines: [...entry.baseLines], startLine: entry.baseLine + 1 };
  }
  const lines = [
    markerLine(OURS_PREFIX, entry.oursLabel),
    ...entry.oursLines,
    ...(entry.baseLines === undefined ? [] : [markerLine(BASE_PREFIX, entry.baseLabel), ...entry.baseLines]),
    SEPARATOR,
    ...entry.theirsLines,
    markerLine(THEIRS_PREFIX, entry.theirsLabel),
  ];
  return { lines, startLine: entry.startLine };
}

export function expandConflictTokens(content: string, entry: ConflictEntry): string {
  const out: string[] = [];
  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    const line = stripTrailingCr(rawLine);
    if (line === "@ours") out.push(...entry.oursLines);
    else if (line === "@theirs") out.push(...entry.theirsLines);
    else if (line === "@base") {
      if (!entry.baseLines) throw new Error(`Conflict #${entry.id} has no base section. @base is only valid for diff3 conflicts.`);
      out.push(...entry.baseLines);
    } else if (line === "@both") out.push(...entry.oursLines, ...entry.theirsLines);
    else out.push(rawLine);
  }
  return out.join("\n");
}

export function spliceConflict(originalText: string, entry: ConflictEntry, replacement: string): string {
  const lines = originalText.split("\n");
  const expected = recordedRegion(entry);
  const match = locateRegion(lines, expected, entry.startLine - 1);
  if (!match) {
    throw new Error(`Conflict #${entry.id} no longer present in '${entry.displayPath}'. Re-read the file to re-register conflicts.`);
  }

  const trimmed = normalizeTrailingNewline(replacement);
  let replacementLines = trimmed.split("\n").map(stripTrailingCr);
  if (lines[match.startIdx]?.endsWith("\r")) {
    const hasFollowingLine = match.endIdx + 1 < lines.length;
    replacementLines = replacementLines.map((line, index) =>
      index < replacementLines.length - 1 || hasFollowingLine ? `${line}\r` : line,
    );
  }

  return [...lines.slice(0, match.startIdx), ...replacementLines, ...lines.slice(match.endIdx + 1)].join("\n");
}

export function conflictRegionPresent(content: string, entry: ConflictEntry): boolean {
  const normalized = content.includes("\r") ? content.replace(/\r\n/g, "\n") : content;
  return normalized.includes(recordedRegion(entry).join("\n"));
}

export function conflictRegionsEqual(left: ConflictBlock, right: ConflictBlock): boolean {
  const leftRegion = recordedRegion(left);
  const rightRegion = recordedRegion(right);
  return leftRegion.length === rightRegion.length && leftRegion.every((line, index) => line === rightRegion[index]);
}

export function formatConflictSummary(entries: readonly ConflictEntry[], displayPath: string): string {
  if (!entries.length) return `No unresolved git merge conflicts in ${displayPath}.`;
  const lines = [`${entries.length} unresolved conflict${entries.length === 1 ? "" : "s"} in ${displayPath}:`];
  for (const entry of entries) {
    const kind = entry.baseLines ? "3-way" : "2-way";
    lines.push(`- conflict://${entry.id} lines ${entry.startLine}-${entry.endLine} (${kind})`);
  }
  lines.push("");
  lines.push("NOTICE: Bulk-resolve with `write({ path: \"conflict://*\", content })`, or address a single block with `write({ path: \"conflict://<N>\", content })`. Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` for one side).");
  return lines.join("\n");
}

export function formatConflictWarning(entries: readonly ConflictEntry[]): string {
  if (!entries.length) return "";
  const word = entries.length === 1 ? "conflict" : "conflicts";
  return [
    `⚠ ${entries.length} unresolved ${word} detected`,
    ...entries.map((entry) => `- conflict://${entry.id} in ${entry.displayPath}:${entry.startLine}-${entry.endLine}`),
    "NOTICE: Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` for one side). Resolve with `write({ path: \"conflict://<N>\", content })`, or bulk-resolve every registered conflict with `write({ path: \"conflict://*\", content })`.",
  ].join("\n");
}

function markerLabel(line: string | undefined, prefix: string): string | undefined {
  if (line === undefined) return undefined;
  const stripped = stripTrailingCr(line);
  if (stripped === prefix) return "";
  if (!stripped.startsWith(`${prefix} `)) return undefined;
  return stripped.slice(prefix.length + 1);
}

function markerLine(prefix: string, label: string | undefined): string {
  return label ? `${prefix} ${label}` : prefix;
}

function recordedRegion(entry: ConflictBlock): string[] {
  return [
    markerLine(OURS_PREFIX, entry.oursLabel),
    ...entry.oursLines,
    ...(entry.baseLines === undefined ? [] : [markerLine(BASE_PREFIX, entry.baseLabel), ...entry.baseLines]),
    SEPARATOR,
    ...entry.theirsLines,
    markerLine(THEIRS_PREFIX, entry.theirsLabel),
  ];
}

function locateRegion(lines: readonly string[], expected: readonly string[], preferredIdx: number): { startIdx: number; endIdx: number } | null {
  if (expected.length === 0 || expected.length > lines.length) return null;
  if (preferredIdx >= 0 && matchesAt(lines, preferredIdx, expected)) {
    return { startIdx: preferredIdx, endIdx: preferredIdx + expected.length - 1 };
  }

  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= lines.length - expected.length; index++) {
    if (!matchesAt(lines, index, expected)) continue;
    const distance = Math.abs(index - preferredIdx);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best === null ? null : { startIdx: best, endIdx: best + expected.length - 1 };
}

function matchesAt(lines: readonly string[], startIdx: number, expected: readonly string[]): boolean {
  if (startIdx < 0 || startIdx + expected.length > lines.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (stripTrailingCr(lines[startIdx + index] ?? "") !== expected[index]) return false;
  }
  return true;
}

function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function normalizeTrailingNewline(replacement: string): string {
  if (replacement.endsWith("\r\n")) return replacement.slice(0, -2);
  if (replacement.endsWith("\n")) return replacement.slice(0, -1);
  return replacement;
}

function cloneEntry<T extends ConflictBlock>(entry: T): T {
  return {
    ...entry,
    oursLines: [...entry.oursLines],
    theirsLines: [...entry.theirsLines],
    baseLines: entry.baseLines ? [...entry.baseLines] : undefined,
  };
}
