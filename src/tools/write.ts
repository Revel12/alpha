import * as fs from "node:fs/promises";
import * as pathModule from "node:path";
import * as vscode from "vscode";
import { ensureToolPermission } from "../approval";
import { writeApproval, writeApprovalDetails } from "../approvalCore";
import { assertWritableGeneratedContent, assertWritableGeneratedFile } from "../generatedGuard";
import { renderAnchoredFileWithTag } from "../hash";
import { isInternalUrlPath, writeInternalUrl } from "../internalUrls";
import type { ToolDefinition } from "../types";
import { relativePath, resolveWorkspaceFile, stat, writeText } from "../workspace";
import { parseArchiveWriteTarget, parseSqliteWriteTarget, writeArchiveEntry, writeSqliteRow } from "../writeAdapters";

interface WriteInput {
  path: string;
  content: string;
  overwriteGenerated?: boolean;
  createDocumentation?: boolean;
}

export const writeTool: ToolDefinition = {
  name: "write",
  summary: "Write a workspace file, internal URL, archive member, or SQLite row.",
  async run(args, ctx) {
    const input = parseWriteInput(args);
    await ensureToolPermission(
      { name: "write", approval: writeApproval, formatApprovalDetails: writeApprovalDetails },
      input,
      ctx,
    );

    if (isInternalUrlPath(input.path)) {
      const { content, stripped } = stripHashlineDisplay(input.content);
      const resource = await writeInternalUrl(input.path, content, ctx);
      const notes = stripped ? ["Note: auto-stripped hashline display prefixes from content before writing."] : [];
      return { markdown: [`Wrote ${resource.url}.`, ...notes].join("\n\n") };
    }

    const archiveTarget = parseArchiveWriteTarget(input.path);
    if (archiveTarget) {
      const archiveUri = await resolveWorkspaceFile(archiveTarget.archivePath);
      const archivePath = relativePath(archiveUri);
      await enforceWriteGuards(archiveUri, archivePath, input, { allowMissing: true });
      assertWritableGeneratedContent(input.content, archiveTarget.memberPath, input.overwriteGenerated);

      let existingBytes: Uint8Array | undefined;
      try {
        existingBytes = await vscode.workspace.fs.readFile(archiveUri);
      } catch {
        existingBytes = undefined;
      }

      const { content, stripped } = stripHashlineDisplay(input.content);
      const archiveBytes = await writeArchiveEntry(archivePath, existingBytes, archiveTarget.memberPath, content);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(pathModule.dirname(archiveUri.fsPath)));
      await vscode.workspace.fs.writeFile(archiveUri, archiveBytes);
      const notes = stripped ? ["Note: auto-stripped hashline display prefixes from content before writing."] : [];
      return { markdown: [`Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${archivePath}:${archiveTarget.memberPath}.`, ...notes].join("\n\n") };
    }

    const sqliteTarget = parseSqliteWriteTarget(input.path);
    if (sqliteTarget) {
      const dbUri = await resolveWorkspaceFile(sqliteTarget.dbPath);
      const dbPath = relativePath(dbUri);
      await enforceWriteGuards(dbUri, dbPath, input, { allowMissing: false });
      const { content, stripped } = stripHashlineDisplay(input.content);
      const result = await writeSqliteRow(dbUri.fsPath, { ...sqliteTarget, dbPath }, content);
      const notes = stripped ? ["Note: auto-stripped hashline display prefixes from content before writing."] : [];
      return { markdown: [result, ...notes].join("\n\n") };
    }

    const uri = await resolveWorkspaceFile(input.path);
    const path = relativePath(uri);
    await enforceWriteGuards(uri, path, input, { allowMissing: true });

    const { content, stripped } = stripHashlineDisplay(input.content);
    assertWritableGeneratedContent(content, path, input.overwriteGenerated);
    await writeText(uri, content);
    const postWrite = await runPostWriteHooks(uri, path);
    const finalContent = postWrite.content ?? content;
    const snapshot = ctx.snapshots.record(path, finalContent);
    const notes = [
      stripped ? "Note: auto-stripped hashline display prefixes from content before writing." : undefined,
      postWrite.formatted ? "Formatted document after writing." : undefined,
      postWrite.madeExecutable ? "Marked file executable because content starts with a shebang." : undefined,
      postWrite.diagnostics,
    ].filter((note): note is string => Boolean(note));
    return { markdown: [`Wrote ${path}.`, ...notes, renderAnchoredFileWithTag(path, finalContent, snapshot.tag)].join("\n\n") };
  },
};

function parseWriteInput(args: string): WriteInput {
  const trimmed = args.trimStart();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Partial<WriteInput>;
    if (typeof parsed.path !== "string" || !parsed.path.trim()) throw new Error("write path is required.");
    if (typeof parsed.content !== "string") throw new Error("write content is required.");
    return {
      path: parsed.path,
      content: parsed.content,
      overwriteGenerated: parsed.overwriteGenerated,
      createDocumentation: parsed.createDocumentation,
    };
  }

  const [pathLine, ...body] = args.replace(/\r\n/g, "\n").split("\n");
  if (!pathLine?.trim()) throw new Error("write requires a path on the first line.");
  return { path: pathLine.trim(), content: body.join("\n") };
}

async function enforceWriteGuards(uri: vscode.Uri, path: string, input: WriteInput, opts: { allowMissing: boolean }): Promise<void> {
  const exists = await pathExists(uri);
  if (!exists && !opts.allowMissing) {
    throw new Error(`Path not found: ${path}`);
  }

  if (isDocumentationPath(path) && !exists && input.createDocumentation !== true) {
    throw new Error(`Refusing to create documentation file ${path} without createDocumentation=true.`);
  }

  if (isGeneratedOrVendorPath(path) && input.overwriteGenerated !== true) {
    throw new Error(`Refusing to write generated/vendor artifact ${path} without overwriteGenerated=true.`);
  }

  if (exists) {
    await assertWritableGeneratedFile(uri, path, input.overwriteGenerated);
  }
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await stat(uri);
    return true;
  } catch {
    return false;
  }
}

function isDocumentationPath(path: string): boolean {
  const basename = path.split(/[\\/]/).pop()?.toLowerCase() ?? path.toLowerCase();
  return basename === "readme" || basename.startsWith("readme.") || basename.endsWith(".md") || basename.endsWith(".mdx");
}

function isGeneratedOrVendorPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)(node_modules|dist|build|coverage|out|target|vendor)\//.test(normalized)) return true;
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|cargo\.lock|poetry\.lock)$/.test(normalized)) return true;
  if (normalized.endsWith(".min.js") || normalized.endsWith(".generated.ts") || normalized.endsWith(".generated.js")) return true;
  return false;
}

function stripHashlineDisplay(content: string): { content: string; stripped: boolean } {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (!lines[0]?.match(/^\[.+#[A-Fa-f0-9]{4}\]\s*$/)) return { content, stripped: false };

  const withoutHeader = lines.slice(1);
  const withoutFence = withoutHeader.filter((line) => line !== "```text" && line !== "```");
  const stripped = withoutFence.map((line) => {
    const match = line.match(/^\d+:(.*)$/);
    return match ? match[1] : line;
  });
  return { content: stripped.join("\n"), stripped: true };
}

async function runPostWriteHooks(uri: vscode.Uri, displayPath: string): Promise<{ content?: string; formatted: boolean; diagnostics?: string; madeExecutable: boolean }> {
  const config = vscode.workspace.getConfiguration("alpha");
  const formatOnWrite = config.get<boolean>("write.formatOnWrite", false);
  const diagnosticsOnWrite = config.get<boolean>("write.diagnosticsOnWrite", true);
  let formatted = false;
  let document = await vscode.workspace.openTextDocument(uri);

  if (formatOnWrite) {
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider",
      uri,
      { tabSize: 2, insertSpaces: true },
    );
    if (edits?.length) {
      const workspaceEdit = new vscode.WorkspaceEdit();
      for (const edit of edits) workspaceEdit.replace(uri, edit.range, edit.newText);
      formatted = await vscode.workspace.applyEdit(workspaceEdit);
      if (formatted) {
        document = await vscode.workspace.openTextDocument(uri);
        await document.save();
      }
    }
  }

  await vscode.window.showTextDocument(uri, { preview: false });
  const madeExecutable = await maybeMarkExecutable(uri, document.getText());
  const diagnostics = diagnosticsOnWrite ? formatDiagnostics(displayPath, vscode.languages.getDiagnostics(uri)) : undefined;
  return { content: document.getText(), formatted, diagnostics, madeExecutable };
}

async function maybeMarkExecutable(uri: vscode.Uri, content: string): Promise<boolean> {
  if (uri.scheme !== "file" || !content.startsWith("#!")) return false;
  try {
    const fileStat = await fs.stat(uri.fsPath);
    const currentMode = fileStat.mode & 0o7777;
    const newMode = currentMode | 0o111;
    if (newMode === currentMode) return false;
    await fs.chmod(uri.fsPath, newMode);
    return true;
  } catch {
    return false;
  }
}

function formatDiagnostics(displayPath: string, diagnostics: vscode.Diagnostic[]): string | undefined {
  if (!diagnostics.length) return undefined;
  const bySeverity = new Map<vscode.DiagnosticSeverity, number>();
  for (const diagnostic of diagnostics) {
    bySeverity.set(diagnostic.severity, (bySeverity.get(diagnostic.severity) ?? 0) + 1);
  }
  const summary = [
    `${bySeverity.get(vscode.DiagnosticSeverity.Error) ?? 0} errors`,
    `${bySeverity.get(vscode.DiagnosticSeverity.Warning) ?? 0} warnings`,
    `${bySeverity.get(vscode.DiagnosticSeverity.Information) ?? 0} info`,
    `${bySeverity.get(vscode.DiagnosticSeverity.Hint) ?? 0} hints`,
  ].join(", ");
  const examples = diagnostics.slice(0, 8).map((diagnostic) => {
    const line = diagnostic.range.start.line + 1;
    const column = diagnostic.range.start.character + 1;
    return `- ${displayPath}:${line}:${column} ${diagnostic.message}`;
  });
  return [`Diagnostics after write: ${summary}.`, ...examples].join("\n");
}
