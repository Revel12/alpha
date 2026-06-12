import * as vscode from "vscode";
import { renderAnchoredFileWithTag } from "../hash";
import type { AlphaContext, ToolDefinition } from "../types";
import { readDirectory, readText, relativePath, resolveWorkspaceFile, stat } from "../workspace";

interface ReadTarget {
  path: string;
  raw: boolean;
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
    const target = parseReadTarget(args.trim() || "active");

    if (target.path === "active" || target.path === "selection" || target.path === "active:selection") {
      return readActiveEditor(target, ctx);
    }

    const uri = await resolveWorkspaceFile(target.path);
    const fileStat = await stat(uri);

    if (fileStat.type === vscode.FileType.Directory) {
      return { markdown: await renderDirectory(uri) };
    }

    const content = await readText(uri, maxBytes);
    if (target.raw) return { markdown: renderRawContent(content, target.ranges) };

    const path = relativePath(uri);
    const snapshot = ctx.snapshots.record(path, content);
    return { markdown: renderContent(path, content, snapshot.tag, target.ranges) };
  },
};

export function parseReadTarget(input: string): ReadTarget {
  let rest = input.trim();
  let raw = false;

  if (rest.endsWith(":raw")) {
    raw = true;
    rest = rest.slice(0, -4);
  }

  const rangeSuffix = rest.match(/:((?:[Ll]?\d+(?:(?:-|\.\.)[Ll]?\d*|\+[Ll]?\d+)?)(?:,[Ll]?\d+(?:(?:-|\.\.)[Ll]?\d*|\+[Ll]?\d+)?)*)$/);
  if (rangeSuffix) {
    rest = rest.slice(0, rangeSuffix.index ?? rest.length);
  }

  if (rest.endsWith(":raw")) {
    raw = true;
    rest = rest.slice(0, -4);
  }

  return {
    path: rest,
    raw,
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

  if (target.raw) return { markdown: renderRawContent(fullText, target.ranges) };

  return { markdown: renderContent(path, fullText, tag, target.ranges) };
}

async function renderDirectory(uri: vscode.Uri): Promise<string> {
  const entries = await readDirectory(uri);
  const path = relativePath(uri);
  const lines = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, type]) => `${type === vscode.FileType.Directory ? "dir " : "file"}  ${name}`);

  return [`[${path}/]`, "```text", ...lines, "```"].join("\n");
}

function renderContent(path: string, content: string, tag: string, ranges?: ReadRange[]): string {
  if (!ranges?.length) return renderAnchoredFileWithTag(path, content, tag);

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
