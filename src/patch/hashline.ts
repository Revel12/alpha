import * as vscode from "vscode";
import { contentHash } from "../hash";
import { lineRange, readText, resolveWorkspaceFile } from "../workspace";
import type { WorkspaceTextEdit } from "../types";

interface ParsedHashlineEdit {
  path: string;
  expectedHash?: string;
  startLine: number;
  endLine: number;
  newText: string;
}

export function parseHashlineEdits(input: string): ParsedHashlineEdit[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const edits: ParsedHashlineEdit[] = [];
  let currentPath: string | undefined;
  let expectedHash: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^¶(.+?)(?:#([a-f0-9]{8,64}))?\s*$/i);
    if (header) {
      currentPath = header[1].trim();
      expectedHash = header[2];
      continue;
    }

    const replace = lines[i].match(/^replace\s+(\d+)(?::(\d+))?\s*$/i);
    if (!replace || !currentPath) continue;

    const startLine = Number(replace[1]);
    const endLine = Number(replace[2] ?? replace[1]);
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^¶/.test(lines[i]) && !/^replace\s+\d+/i.test(lines[i])) {
      const line = lines[i];
      if (line.startsWith("+")) body.push(line.slice(1));
      else if (line.startsWith(" ")) body.push(line.slice(1));
      i++;
    }
    i--;
    edits.push({
      path: currentPath,
      expectedHash,
      startLine,
      endLine,
      newText: body.join("\n") + (body.length ? "\n" : ""),
    });
  }

  return edits;
}

export async function buildWorkspaceEdits(input: string, maxBytes: number): Promise<WorkspaceTextEdit[]> {
  const parsed = parseHashlineEdits(input);
  if (!parsed.length) {
    throw new Error("No hashline edits found. Expected ¶path#hash followed by replace start:end and +new lines.");
  }

  const edits: WorkspaceTextEdit[] = [];
  for (const item of parsed) {
    const uri = await resolveWorkspaceFile(item.path);
    const content = await readText(uri, maxBytes);
    if (item.expectedHash && contentHash(content) !== item.expectedHash) {
      throw new Error(`Hash mismatch for ${item.path}; run read again before editing.`);
    }
    const document = await vscode.workspace.openTextDocument(uri);
    edits.push({
      uri,
      range: lineRange(document, item.startLine, item.endLine),
      newText: item.newText,
    });
  }
  return edits;
}

export async function applyWorkspaceEdits(edits: WorkspaceTextEdit[]): Promise<boolean> {
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const edit of edits) {
    workspaceEdit.replace(edit.uri, edit.range, edit.newText);
  }
  return vscode.workspace.applyEdit(workspaceEdit);
}
