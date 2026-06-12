import * as vscode from "vscode";
import { renderAnchoredFileWithTag } from "../hash";
import type { AlphaContext, ToolDefinition } from "../types";
import { readDirectory, readText, relativePath, resolveExistingWorkspacePath, stat } from "../workspace";

interface ReadTarget {
  path: string;
  raw: boolean;
  conflicts: boolean;
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

    const uri = await resolveExistingWorkspacePath(target.path);
    const fileStat = await stat(uri);

    if (fileStat.type === vscode.FileType.Directory) {
      return { markdown: await renderDirectory(uri) };
    }

    const content = await readText(uri, maxBytes);
    if (target.raw) return { markdown: renderRawContent(content, target.ranges) };

    const path = relativePath(uri);
    const snapshot = ctx.snapshots.record(path, content);
    if (target.conflicts) return { markdown: renderConflicts(path, content, snapshot.tag) };
    return { markdown: renderContent(path, content, snapshot.tag, target.ranges, target.explicitSelector ? undefined : defaultLimit) };
  },
};

export function parseReadTarget(input: string): ReadTarget {
  let rest = input.trim();
  let raw = false;
  let conflicts = false;
  let explicitSelector = false;

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

  if (target.conflicts) return { markdown: renderConflicts(path, fullText, tag) };
  if (target.raw) return { markdown: renderRawContent(fullText, target.ranges) };

  return { markdown: renderContent(path, fullText, tag, target.ranges, target.explicitSelector ? undefined : 200) };
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

function renderContent(path: string, content: string, tag: string, ranges?: ReadRange[], defaultLimit?: number): string {
  if (!ranges?.length) {
    const lines = content.split(/\r?\n/);
    if (defaultLimit && lines.length > defaultLimit) {
      const selected = lines.slice(0, defaultLimit).map((line, index) => `${index + 1}:${line}`);
      selected.push(`[${lines.length - defaultLimit} lines elided; re-read needed ranges, e.g. ${path}:${defaultLimit + 1}-${Math.min(lines.length, defaultLimit + 80)}]`);
      return [`[${path}#${tag}]`, "```text", ...selected, "```"].join("\n");
    }
    return renderAnchoredFileWithTag(path, content, tag);
  }

  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  for (const range of ranges) {
    const start = range.startLine;
    const end = Math.min(lines.length, range.endLine ?? lines.length);
    for (let line = start; line <= end; line++) {
      selected.push(`${line}:${lines[line - 1] ?? ""}`);
    }
  }
  return [`[${path}#${tag}]`, "```text", ...selected, "```"].join("\n");
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

function renderConflicts(path: string, content: string, tag: string): string {
  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  let inConflict = false;
  let start = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("<<<<<<<")) {
      inConflict = true;
      start = Math.max(0, index - 2);
    }
    if (inConflict && line.startsWith(">>>>>>>")) {
      const end = Math.min(lines.length - 1, index + 2);
      for (let lineIndex = start; lineIndex <= end; lineIndex++) {
        selected.push(`${lineIndex + 1}:${lines[lineIndex] ?? ""}`);
      }
      inConflict = false;
    }
  }

  if (!selected.length) return `[${path}#${tag}]\nNo conflict markers found.`;
  return [`[${path}#${tag}]`, "```text", ...selected, "```"].join("\n");
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
