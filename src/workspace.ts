import * as path from "node:path";
import * as vscode from "vscode";

export function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

export function workspaceRoot(): vscode.Uri {
  const [first] = workspaceFolders();
  if (!first) {
    throw new Error("Alpha requires an open workspace folder.");
  }
  return first.uri;
}

export function relativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

export async function resolveWorkspaceFile(input: string): Promise<vscode.Uri> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Expected a workspace-relative path.");
  }

  if (path.isAbsolute(trimmed)) {
    const uri = vscode.Uri.file(trimmed);
    ensureInsideWorkspace(uri);
    return uri;
  }

  const uri = vscode.Uri.joinPath(workspaceRoot(), trimmed);
  ensureInsideWorkspace(uri);
  return uri;
}

export function ensureInsideWorkspace(uri: vscode.Uri): void {
  const fsPath = path.resolve(uri.fsPath);
  const inside = workspaceFolders().some((folder) => {
    const root = path.resolve(folder.uri.fsPath);
    return fsPath === root || fsPath.startsWith(root + path.sep);
  });
  if (!inside) {
    throw new Error(`Path is outside the open workspace: ${uri.fsPath}`);
  }
}

export async function readText(uri: vscode.Uri, maxBytes: number): Promise<string> {
  ensureInsideWorkspace(uri);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > maxBytes) {
    return Buffer.from(bytes.subarray(0, maxBytes)).toString("utf8") + "\n...[truncated]";
  }
  return Buffer.from(bytes).toString("utf8");
}

export async function readOpenDocumentText(uri: vscode.Uri, maxBytes: number): Promise<string> {
  ensureInsideWorkspace(uri);
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  if (open) return truncateText(open.getText(), maxBytes);

  try {
    const document = await vscode.workspace.openTextDocument(uri);
    return truncateText(document.getText(), maxBytes);
  } catch {
    return readText(uri, maxBytes);
  }
}

export async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  ensureInsideWorkspace(uri);
  await ensureParentDirectory(uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

export async function stat(uri: vscode.Uri): Promise<vscode.FileStat> {
  ensureInsideWorkspace(uri);
  return vscode.workspace.fs.stat(uri);
}

export async function readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  ensureInsideWorkspace(uri);
  return vscode.workspace.fs.readDirectory(uri);
}

export function lineRange(document: vscode.TextDocument, startLineOneBased: number, endLineOneBased: number): vscode.Range {
  if (startLineOneBased < 1 || endLineOneBased < startLineOneBased || startLineOneBased > document.lineCount) {
    throw new Error(`Invalid line range ${startLineOneBased}..${endLineOneBased} for ${document.lineCount} line document.`);
  }

  const start = Math.max(0, startLineOneBased - 1);
  const endExclusive = Math.min(document.lineCount, Math.max(start + 1, endLineOneBased));
  return new vscode.Range(
    new vscode.Position(start, 0),
    document.lineAt(endExclusive - 1).rangeIncludingLineBreak.end,
  );
}

export function insertionPosition(document: vscode.TextDocument, lineOneBased: number, side: "before" | "after"): vscode.Position {
  if (lineOneBased < 1) {
    throw new Error(`Invalid insertion line ${lineOneBased}.`);
  }

  if (side === "before") {
    const line = Math.max(0, Math.min(document.lineCount, lineOneBased - 1));
    return new vscode.Position(line, 0);
  }
  const line = Math.max(0, Math.min(document.lineCount - 1, lineOneBased - 1));
  return document.lineAt(line).rangeIncludingLineBreak.end;
}

async function ensureParentDirectory(uri: vscode.Uri): Promise<void> {
  const parent = vscode.Uri.file(path.dirname(uri.fsPath));
  ensureInsideWorkspace(parent);
  await vscode.workspace.fs.createDirectory(parent);
}

function truncateText(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  return Buffer.from(bytes.subarray(0, maxBytes)).toString("utf8") + "\n...[truncated]";
}
