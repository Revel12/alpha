import * as vscode from "vscode";
import { matchesContentTag } from "../hash";
import { insertionPosition, lineRange, readText, resolveWorkspaceFile } from "../workspace";
import type { WorkspaceTextEdit } from "../types";

type HashlineOperation = "replace" | "delete" | "insert";

interface ParsedHashlineEdit {
  path: string;
  expectedTag?: string;
  operation: HashlineOperation;
  startLine: number;
  endLine: number;
  insertSide?: "before" | "after";
  newText: string;
}

export function parseHashlineEdits(input: string): ParsedHashlineEdit[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const edits: ParsedHashlineEdit[] = [];
  let currentPath: string | undefined;
  let expectedTag: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const header = parseHeader(lines[i]);
    if (header) {
      currentPath = header.path;
      expectedTag = header.expectedTag;
      continue;
    }

    if (!currentPath) continue;

    const command = parseCommand(lines[i]);
    if (!command) continue;

    const body: string[] = [];
    if (command.operation !== "delete") {
      i++;
      while (i < lines.length && !parseHeader(lines[i]) && !parseCommand(lines[i])) {
        const line = lines[i];
        if (line.startsWith("+")) {
          body.push(line.slice(1));
        } else if (line.trim() || body.length) {
          throw new Error("Hashline edit body lines must start with '+'.");
        }
        i++;
      }
      i--;
    }

    edits.push({
      path: currentPath,
      expectedTag,
      operation: command.operation,
      startLine: command.startLine,
      endLine: command.endLine,
      insertSide: command.insertSide,
      newText: body.length ? body.join("\n") + "\n" : "",
    });
  }

  return edits;
}

export async function buildWorkspaceEdits(input: string, maxBytes: number): Promise<WorkspaceTextEdit[]> {
  const parsed = parseHashlineEdits(input);
  if (!parsed.length) {
    throw new Error("No hashline edits found. Expected [path#TAG] followed by replace/delete/insert operations.");
  }

  const edits: WorkspaceTextEdit[] = [];
  for (const item of parsed) {
    const uri = await resolveWorkspaceFile(item.path);
    const content = await readText(uri, maxBytes);
    if (item.expectedTag && !matchesContentTag(content, item.expectedTag)) {
      throw new Error(`Content tag mismatch for ${item.path}; run read again before editing.`);
    }

    const document = await vscode.workspace.openTextDocument(uri);
    edits.push({
      uri,
      range: editRange(document, item),
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

function parseHeader(line: string): { path: string; expectedTag?: string } | undefined {
  const omp = line.match(/^\[(.+?)#([A-Fa-f0-9]{4,64})\]\s*$/);
  if (omp) return { path: omp[1].trim(), expectedTag: omp[2] };

  const legacy = line.match(/^¶(.+?)(?:#([A-Fa-f0-9]{4,64}))?\s*$/);
  if (legacy) return { path: legacy[1].trim(), expectedTag: legacy[2] };

  return undefined;
}

function parseCommand(
  line: string,
): { operation: HashlineOperation; startLine: number; endLine: number; insertSide?: "before" | "after" } | undefined {
  const replace = line.match(/^replace\s+(\d+)(?:(?:\.\.|:)(\d+))?\s*$/i);
  if (replace) {
    const startLine = Number(replace[1]);
    const endLine = Number(replace[2] ?? replace[1]);
    return { operation: "replace", startLine, endLine };
  }

  const deleteMatch = line.match(/^delete\s+(\d+)(?:(?:\.\.|:)(\d+))?\s*$/i);
  if (deleteMatch) {
    const startLine = Number(deleteMatch[1]);
    const endLine = Number(deleteMatch[2] ?? deleteMatch[1]);
    return { operation: "delete", startLine, endLine };
  }

  const insert = line.match(/^insert\s+(before|after)\s+(\d+)\s*$/i);
  if (insert) {
    const side = insert[1].toLowerCase() as "before" | "after";
    const lineNumber = Number(insert[2]);
    return { operation: "insert", startLine: lineNumber, endLine: lineNumber, insertSide: side };
  }

  const head = line.match(/^insert\s+head\s*$/i);
  if (head) return { operation: "insert", startLine: 1, endLine: 1, insertSide: "before" };

  const tail = line.match(/^insert\s+tail\s*$/i);
  if (tail) return { operation: "insert", startLine: Number.MAX_SAFE_INTEGER, endLine: Number.MAX_SAFE_INTEGER, insertSide: "after" };

  return undefined;
}

function editRange(document: vscode.TextDocument, edit: ParsedHashlineEdit): vscode.Range {
  if (edit.operation === "insert") {
    const targetLine = Math.min(edit.startLine, document.lineCount);
    const position = insertionPosition(document, targetLine, edit.insertSide ?? "before");
    return new vscode.Range(position, position);
  }

  return lineRange(document, edit.startLine, edit.endLine);
}
