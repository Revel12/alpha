import * as vscode from "vscode";
import {
  formatConflictSummary,
  formatConflictWarning,
  parseConflictUri,
  registerConflicts,
  renderConflictRegion,
  scanConflictLines,
} from "../conflictCore";
import { renderAnchoredFileWithTag } from "../hash";
import { isInternalUrlPath, resolveInternalUrl, type InternalResource } from "../internalUrls";
import {
  isWebUrlPath,
  readArchiveTarget,
  readSpecialFile,
  readSqliteTarget,
  readWebUrl,
  splitArchiveTarget,
  splitSqliteTarget,
  structuralSummary,
  type ReadAdapterResult,
} from "../readAdapters";
import type { AlphaContext, ToolDefinition } from "../types";
import { readDirectory, readText, relativePath, resolveExistingWorkspacePath, stat } from "../workspace";

interface ReadTarget {
  path: string;
  raw: boolean;
  conflicts: boolean;
  summary: boolean;
  explicitSelector: boolean;
  ranges?: ReadRange[];
}

interface ReadRange {
  startLine: number;
  endLine?: number;
}

export const readTool: ToolDefinition = {
  name: "read",
  summary: "Read a workspace file, directory, active editor, or selection and return hash-anchored text.",
  async run(args, ctx) {
    const config = vscode.workspace.getConfiguration("alpha");
    const maxBytes = config.get<number>("read.maxBytes", 200000);
    const defaultLimit = Math.max(1, Math.min(config.get<number>("read.defaultLimit", 200), 2000));
    const target = parseReadTarget(args.trim() || "active");

    if (target.path === "active" || target.path === "selection" || target.path === "active:selection") {
      return readActiveEditor(target, ctx);
    }

    const conflictUri = parseConflictUri(target.path);
    if (conflictUri) {
      if (conflictUri.id === "*") {
        throw new Error("Reading `conflict://*` is not supported; wildcards are write-only. Use `<path>:conflicts` to list conflicts.");
      }
      return { markdown: renderRegisteredConflict(conflictUri.id, conflictUri.scope, ctx) };
    }

    if (isWebUrlPath(target.path)) {
      const resource = await readWebUrlWithFallback(target.path, target.raw, ctx);
      if (target.raw) return { markdown: renderRawContent(resource.content, target.ranges) };
      return { markdown: renderAdapterResource(resource, target.ranges, target.explicitSelector ? undefined : defaultLimit) };
    }

    if (isInternalUrlPath(target.path)) {
      const resource = await resolveInternalUrl(target.path, ctx);
      if (target.raw) return { markdown: renderRawContent(resource.content, target.ranges) };
      return {
        markdown: renderAdapterResource(resource, target.ranges, target.explicitSelector ? undefined : defaultLimit),
      };
    }

    const archiveTarget = splitArchiveTarget(target.path);
    if (archiveTarget) {
      const archiveUri = await resolveExistingWorkspacePath(archiveTarget.archivePath);
      const bytes = await vscode.workspace.fs.readFile(archiveUri);
      const archivePath = relativePath(archiveUri);
      const resource = await readArchiveTarget(archivePath, bytes, archiveTarget.memberPath);
      if (target.raw) return { markdown: renderRawContent(resource.content, target.ranges) };
      return { markdown: renderAdapterResource(resource, target.ranges, target.explicitSelector ? undefined : defaultLimit) };
    }

    const sqliteTarget = splitSqliteTarget(target.path);
    if (sqliteTarget) {
      const dbUri = await resolveExistingWorkspacePath(sqliteTarget.dbPath);
      const dbPath = relativePath(dbUri);
      const resource = await readSqliteTarget(dbUri.fsPath, sqliteTarget.selector);
      resource.label = resource.label.replace(dbUri.fsPath, dbPath);
      if (target.raw) return { markdown: renderRawContent(resource.content, target.ranges) };
      return { markdown: renderAdapterResource(resource, target.ranges, target.explicitSelector ? undefined : defaultLimit) };
    }

    const uri = await resolveExistingWorkspacePath(target.path);
    const fileStat = await stat(uri);

    if (fileStat.type === vscode.FileType.Directory) {
      return { markdown: await renderDirectory(uri) };
    }

    const path = relativePath(uri);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const special = readSpecialFile(path, bytes, target.raw);
    if (special) {
      if (target.raw) return { markdown: renderRawContent(special.content, target.ranges) };
      return { markdown: renderAdapterResource(special, target.ranges, target.explicitSelector ? undefined : defaultLimit) };
    }

    const content = await readText(uri, maxBytes);
    if (target.raw) return { markdown: renderRawContent(content, target.ranges) };

    const snapshot = ctx.snapshots.record(path, content);
    if (target.conflicts) return { markdown: renderConflicts(path, content, snapshot.tag, ctx) };
    const hasConflictMarkers = content.includes("<<<<<<<") && content.includes(">>>>>>>");
    if (!hasConflictMarkers && (target.summary || (!target.explicitSelector && !target.ranges?.length))) {
      const summary = structuralSummary(path, content);
      if (summary) return { markdown: [`[${path}#${snapshot.tag}]`, "```text", summary, "```"].join("\n") };
    }
    return { markdown: renderContent(path, content, snapshot.tag, target.ranges, target.explicitSelector ? undefined : defaultLimit, ctx) };
  },
};

async function readWebUrlWithFallback(path: string, raw: boolean, ctx: AlphaContext): Promise<ReadAdapterResult> {
  try {
    return await readWebUrl(path, raw);
  } catch (error) {
    if (raw || !vscode.lm.tools.some((tool) => tool.name === "copilot_fetchWebPage")) {
      throw error;
    }
    const result = await vscode.lm.invokeTool("copilot_fetchWebPage", {
      toolInvocationToken: ctx.request.toolInvocationToken,
      input: {
        urls: [path],
        query: "Extract the main readable page content as concise markdown or plain text.",
      },
    }, ctx.token);
    const content = languageModelToolResultToText(result);
    if (!content.trim()) throw error;
    return {
      label: `${path} (copilot_fetchWebPage)`,
      content,
      immutable: true,
    };
  }
}

function languageModelToolResultToText(result: vscode.LanguageModelToolResult): string {
  return result.content.map((part) => {
    if (part instanceof vscode.LanguageModelTextPart) return part.value;
    if (part && typeof part === "object" && "value" in part && typeof (part as { value?: unknown }).value === "string") {
      return (part as { value: string }).value;
    }
    return String(part);
  }).join("\n");
}

export function parseReadTarget(input: string): ReadTarget {
  let rest = input.trim();
  let raw = false;
  let conflicts = false;
  let summary = false;
  let explicitSelector = false;

  if (rest.endsWith(":summary")) {
    summary = true;
    explicitSelector = true;
    rest = rest.slice(0, -8);
  }

  if (rest.endsWith(":conflicts")) {
    conflicts = true;
    explicitSelector = true;
    rest = rest.slice(0, -10);
  }

  if (rest.endsWith(":raw")) {
    raw = true;
    explicitSelector = true;
    rest = rest.slice(0, -4);
  }

  const rangeSuffix = rest.match(/:((?:[Ll]?\d+(?:(?:-|\.\.)[Ll]?\d*|\+[Ll]?\d+)?)(?:,[Ll]?\d+(?:(?:-|\.\.)[Ll]?\d*|\+[Ll]?\d+)?)*)$/);
  if (rangeSuffix) {
    explicitSelector = true;
    rest = rest.slice(0, rangeSuffix.index ?? rest.length);
  }

  if (rest.endsWith(":raw")) {
    raw = true;
    explicitSelector = true;
    rest = rest.slice(0, -4);
  }

  return {
    path: rest,
    raw,
    conflicts,
    summary,
    explicitSelector,
    ranges: rangeSuffix ? parseRanges(rangeSuffix[1]) : undefined,
  };
}

async function readActiveEditor(target: ReadTarget, ctx: AlphaContext): Promise<{ markdown: string }> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error("No active editor.");

  const fullText = editor.document.getText();
  const path = relativePath(editor.document.uri);
  const tag = ctx.snapshots.record(path, fullText).tag;

  if (target.path === "selection" || target.path === "active:selection") {
    if (editor.selection.isEmpty) throw new Error("No active selection.");
    const content = editor.document.getText(editor.selection);
    const startLine = editor.selection.start.line + 1;
    return { markdown: renderAnchoredFileWithTag(path, content, tag, startLine) };
  }

  if (target.conflicts) return { markdown: renderConflicts(path, fullText, tag, ctx) };
  if (target.raw) return { markdown: renderRawContent(fullText, target.ranges) };

  const hasConflictMarkers = fullText.includes("<<<<<<<") && fullText.includes(">>>>>>>");
  if (!hasConflictMarkers && (target.summary || (!target.explicitSelector && !target.ranges?.length))) {
    const summary = structuralSummary(path, fullText);
    if (summary) return { markdown: [`[${path}#${tag}]`, "```text", summary, "```"].join("\n") };
  }

  return { markdown: renderContent(path, fullText, tag, target.ranges, target.explicitSelector ? undefined : 200, ctx) };
}

async function renderDirectory(uri: vscode.Uri): Promise<string> {
  const path = relativePath(uri);
  const lines = await renderDirectoryTree(uri, 0, 2, 400);

  return [`[${path}/]`, "```text", ...lines, "```"].join("\n");
}

async function renderDirectoryTree(uri: vscode.Uri, depth: number, maxDepth: number, maxEntries: number): Promise<string[]> {
  if (maxEntries <= 0) return ["...[truncated]"];

  const entries = (await readDirectory(uri)).sort(([left], [right]) => left.localeCompare(right));
  const lines: string[] = [];
  for (const [name, type] of entries) {
    if (lines.length >= maxEntries) {
      lines.push("...[truncated]");
      break;
    }

    const prefix = "  ".repeat(depth);
    const isDirectory = type === vscode.FileType.Directory;
    lines.push(`${prefix}${isDirectory ? "dir " : "file"}  ${name}${isDirectory ? "/" : ""}`);
    if (isDirectory && depth + 1 < maxDepth) {
      const child = vscode.Uri.joinPath(uri, name);
      const childLines = await renderDirectoryTree(child, depth + 1, maxDepth, maxEntries - lines.length);
      lines.push(...childLines);
    }
  }
  return lines;
}

function renderContent(path: string, content: string, tag: string, ranges?: ReadRange[], defaultLimit?: number, ctx?: AlphaContext): string {
  if (!ranges?.length) {
    const lines = content.split(/\r?\n/);
    if (defaultLimit && lines.length > defaultLimit) {
      const selected = lines.slice(0, defaultLimit).map((line, index) => `${index + 1}:${line}`);
      selected.push(`[${lines.length - defaultLimit} lines elided; re-read needed ranges, e.g. ${path}:${defaultLimit + 1}-${Math.min(lines.length, defaultLimit + 80)}]`);
      return appendConflictWarning([`[${path}#${tag}]`, "```text", ...selected, "```"].join("\n"), ctx, path, lines.slice(0, defaultLimit), 1);
    }
    return appendConflictWarning(renderAnchoredFileWithTag(path, content, tag), ctx, path, lines, 1);
  }

  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  const visibleBlocks: Array<{ lines: string[]; firstLine: number }> = [];
  for (const range of ranges) {
    const start = range.startLine;
    const end = Math.min(lines.length, range.endLine ?? lines.length);
    const rangeLines: string[] = [];
    for (let line = start; line <= end; line++) {
      const value = lines[line - 1] ?? "";
      selected.push(`${line}:${value}`);
      rangeLines.push(value);
    }
    visibleBlocks.push({ lines: rangeLines, firstLine: start });
  }
  const rendered = [`[${path}#${tag}]`, "```text", ...selected, "```"].join("\n");
  if (!ctx) return rendered;
  const entries = visibleBlocks.flatMap((block) => registerConflicts(ctx.conflicts, scanConflictLines(block.lines, block.firstLine, path, path)));
  const warning = formatConflictWarning(entries);
  return warning ? `${rendered}\n\n${warning}` : rendered;
}

function renderAdapterResource(resource: InternalResource | ReadAdapterResult, ranges?: ReadRange[], defaultLimit?: number): string {
  const lines = resource.content.split(/\r?\n/);
  const selected: string[] = [];
  const effectiveRanges = ranges?.length ? ranges : [{ startLine: 1, endLine: defaultLimit ? Math.min(defaultLimit, lines.length) : lines.length }];

  for (const range of effectiveRanges) {
    const end = Math.min(lines.length, range.endLine ?? lines.length);
    for (let line = range.startLine; line <= end; line++) {
      selected.push(`${line}:${lines[line - 1] ?? ""}`);
    }
  }

  if (!ranges?.length && defaultLimit && lines.length > defaultLimit) {
    selected.push(`[${lines.length - defaultLimit} lines elided; re-read needed ranges, e.g. ${resourceLabel(resource)}:${defaultLimit + 1}-${Math.min(lines.length, defaultLimit + 80)}]`);
  }

  return [`[${resource.label}]`, "```text", ...selected, "```"].join("\n");
}

function resourceLabel(resource: InternalResource | ReadAdapterResult): string {
  return "url" in resource ? resource.url : resource.label;
}

function renderRawContent(content: string, ranges?: ReadRange[]): string {
  if (!ranges?.length) return content;

  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  for (const range of ranges) {
    const end = Math.min(lines.length, range.endLine ?? lines.length);
    for (let line = range.startLine; line <= end; line++) {
      selected.push(lines[line - 1] ?? "");
    }
  }
  return selected.join("\n");
}

function renderRegisteredConflict(id: number, scope: "ours" | "theirs" | "base" | undefined, ctx: AlphaContext): string {
  const entry = ctx.conflicts.get(id);
  if (!entry) {
    throw new Error(`Conflict #${id} not found. Conflict ids are registered when read surfaces marker blocks; re-read the file or use <path>:conflicts.`);
  }
  const region = renderConflictRegion(entry, scope);
  const lines = region.lines.map((line, index) => `${region.startLine + index}:${line}`);
  const label = scope ? `conflict://${id}/${scope}` : `conflict://${id}`;
  return [`[${label} ${entry.displayPath}]`, "```text", ...lines, "```"].join("\n");
}

function renderConflicts(path: string, content: string, tag: string, ctx: AlphaContext): string {
  const blocks = scanConflictLines(content.split(/\r?\n/), 1, path, path);
  const entries = registerConflicts(ctx.conflicts, blocks);
  return [`[${path}#${tag}]`, formatConflictSummary(entries, path)].join("\n");
}

function appendConflictWarning(rendered: string, ctx: AlphaContext | undefined, path: string, visibleLines: string[], firstLine: number): string {
  if (!ctx) return rendered;
  const blocks = scanConflictLines(visibleLines, firstLine, path, path);
  const entries = registerConflicts(ctx.conflicts, blocks);
  const warning = formatConflictWarning(entries);
  return warning ? `${rendered}\n\n${warning}` : rendered;
}

function parseRanges(input: string): ReadRange[] {
  return mergeRanges(input.split(",").map(parseRange));
}

function parseRange(input: string): ReadRange {
  const chunk = input.replace(/l/gi, "");
  const count = chunk.match(/^(\d+)\+(\d+)$/);
  if (count) {
    const startLine = positiveLine(count[1]);
    const lineCount = positiveLine(count[2]);
    return { startLine, endLine: startLine + lineCount - 1 };
  }

  const bounded = chunk.match(/^(\d+)(?:-|\.\.)(\d*)$/);
  if (bounded) {
    const startLine = positiveLine(bounded[1]);
    const endLine = bounded[2] ? positiveLine(bounded[2]) : undefined;
    if (endLine !== undefined && endLine < startLine) {
      throw new Error(`Invalid line range ${input}; end must be >= start.`);
    }
    return { startLine, endLine };
  }

  const single = chunk.match(/^(\d+)$/);
  if (single) {
    const startLine = positiveLine(single[1]);
    return { startLine, endLine: startLine };
  }

  throw new Error(`Invalid read selector: ${input}`);
}

function positiveLine(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Line selectors are 1-indexed; use :1 or higher.");
  }
  return parsed;
}

function mergeRanges(ranges: ReadRange[]): ReadRange[] {
  const sorted = [...ranges].sort((left, right) => left.startLine - right.startLine);
  const merged: ReadRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...range });
      continue;
    }
    if (previous.endLine === undefined || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
      continue;
    }
    previous.endLine = range.endLine === undefined ? undefined : Math.max(previous.endLine, range.endLine);
  }
  return merged;
}
