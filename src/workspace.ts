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

export async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  ensureInsideWorkspace(uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

export function lineRange(document: vscode.TextDocument, startLineOneBased: number, endLineOneBased: number): vscode.Range {
  const start = Math.max(0, startLineOneBased - 1);
  const endExclusive = Math.min(document.lineCount, Math.max(start + 1, endLineOneBased));
  return new vscode.Range(
    new vscode.Position(start, 0),
    document.lineAt(endExclusive - 1).rangeIncludingLineBreak.end,
  );
}
