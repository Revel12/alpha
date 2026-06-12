import * as vscode from "vscode";
import { contentTag, renderAnchoredFile, renderAnchoredFileWithTag } from "../hash";
import type { ToolDefinition } from "../types";
import { readDirectory, readText, relativePath, resolveWorkspaceFile, stat } from "../workspace";

interface ReadTarget {
  path: string;
  raw: boolean;
  range?: {
    startLine: number;
    endLine: number;
  };
}

export const readTool: ToolDefinition = {
  name: "read",
  summary: "Read a workspace file, directory, active editor, or selection and return hash-anchored text.",
  async run(args) {
    const config = vscode.workspace.getConfiguration("alpha");
    const maxBytes = config.get<number>("read.maxBytes", 200000);
    const target = parseReadTarget(args.trim() || "active");

    if (target.path === "active" || target.path === "selection" || target.path === "active:selection") {
      return readActiveEditor(target);
    }

    const uri = await resolveWorkspaceFile(target.path);
    const fileStat = await stat(uri);

    if (fileStat.type === vscode.FileType.Directory) {
      return { markdown: await renderDirectory(uri) };
    }

    const content = await readText(uri, maxBytes);
    if (target.raw) return { markdown: content };

    return { markdown: renderContent(relativePath(uri), content, target.range) };
  },
};

function parseReadTarget(input: string): ReadTarget {
  let path = input.trim();
  let raw = false;

  if (path.endsWith(":raw")) {
    raw = true;
    path = path.slice(0, -4);
  }

  const rangeMatch = path.match(/:(\d+)(?:(?:-|\.\.)(\d+)|\+(\d+))?$/);
  if (!rangeMatch) return { path, raw };

  const startLine = Number(rangeMatch[1]);
  const explicitEnd = rangeMatch[2] ? Number(rangeMatch[2]) : undefined;
  const count = rangeMatch[3] ? Number(rangeMatch[3]) : undefined;
  const endLine = explicitEnd ?? (count ? startLine + count - 1 : startLine);

  return {
    path: path.slice(0, rangeMatch.index),
    raw,
    range: { startLine, endLine },
  };
}

async function readActiveEditor(target: ReadTarget): Promise<{ markdown: string }> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error("No active editor.");

  const fullText = editor.document.getText();
  const path = relativePath(editor.document.uri);
  const tag = contentTag(fullText);

  if (target.path === "selection" || target.path === "active:selection") {
    if (editor.selection.isEmpty) throw new Error("No active selection.");
    const content = editor.document.getText(editor.selection);
    const startLine = editor.selection.start.line + 1;
    return { markdown: renderAnchoredFileWithTag(path, content, tag, startLine) };
  }

  if (target.raw) return { markdown: fullText };

  return { markdown: renderContent(path, fullText, target.range) };
}

async function renderDirectory(uri: vscode.Uri): Promise<string> {
  const entries = await readDirectory(uri);
  const path = relativePath(uri);
  const lines = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, type]) => `${type === vscode.FileType.Directory ? "dir " : "file"}  ${name}`);

  return [`[${path}/]`, "```text", ...lines, "```"].join("\n");
}

function renderContent(path: string, content: string, range?: ReadTarget["range"]): string {
  if (!range) return renderAnchoredFile(path, content);

  const lines = content.split(/\r?\n/);
  const start = Math.max(1, range.startLine);
  const end = Math.max(start, Math.min(lines.length, range.endLine));
  const excerpt = lines.slice(start - 1, end).join("\n");
  return renderAnchoredFileWithTag(path, excerpt, contentTag(content), start);
}
