import * as fs from "node:fs/promises";
import * as pathModule from "node:path";
import * as vscode from "vscode";
import { ensureToolPermission } from "../approval";
import { writeApproval, writeApprovalDetails } from "../approvalCore";
import {
  expandConflictTokens,
  parseConflictUri,
  spliceConflict,
  type ConflictEntry,
} from "../conflictCore";
import { assertWritableGeneratedContent, assertWritableGeneratedFile } from "../generatedGuard";
import { renderAnchoredFileWithTag } from "../hash";
import { isInternalUrlPath, writeInternalUrl } from "../internalUrls";
import { assertPlanModeWriteAllowed } from "../planMode";
import { postMutationDiagnostics } from "../postMutationDiagnostics";
import type { ToolDefinition } from "../types";
import { readOpenDocumentText, relativePath, resolveWorkspaceFile, stat, writeText } from "../workspace";
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
    assertPlanModeWriteAllowed(input.path, ctx);
    await ensureToolPermission(
      { name: "write", approval: writeApproval, formatApprovalDetails: writeApprovalDetails },
      input,
      ctx,
    );

    const conflictUri = parseConflictUri(input.path);
    if (conflictUri) {
      if (conflictUri.scope) {
        throw new Error(`Conflict URI scope '/${conflictUri.scope}' is read-only. To write, use conflict://${conflictUri.id} and put @${conflictUri.scope} or replacement content in content.`);
      }
      const { content, stripped } = stripHashlineDisplay(input.content);
      const result = conflictUri.id === "*"
        ? await resolveAllConflicts(content, ctx)
        : await resolveSingleConflict(conflictUri.id, content, ctx);
      const notes = [
        conflictUri.recoveredPrefix ? `Note: stripped erroneous '${conflictUri.recoveredPrefix}:' prefix from path; conflict URIs are global.` : undefined,
        stripped ? "Note: auto-stripped hashline display prefixes from content before writing." : undefined,
      ].filter((note): note is string => Boolean(note));
      return { markdown: [result, ...notes].join("\n\n") };
    }

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
    const postWrite = await runPostWriteHooks(uri);
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

async function resolveSingleConflict(id: number, content: string, ctx: Parameters<ToolDefinition["run"]>[1]): Promise<string> {
  const entry = ctx.conflicts.get(id);
  if (!entry) throw new Error(`Conflict #${id} not found. Re-read the file or use <path>:conflicts to register current conflicts.`);
  const resolved = await resolveConflictEntry(entry, content, ctx);
  return `Resolved conflict #${entry.id} in ${entry.displayPath}.\n\n${resolved}`;
}

async function resolveAllConflicts(content: string, ctx: Parameters<ToolDefinition["run"]>[1]): Promise<string> {
  const entries = ctx.conflicts.entries();
  if (!entries.length) throw new Error("No registered conflicts. Read a conflicted file or <path>:conflicts first.");

  const byPath = new Map<string, ConflictEntry[]>();
  for (const entry of entries) {
    const list = byPath.get(entry.path) ?? [];
    list.push(entry);
    byPath.set(entry.path, list);
  }

  const summaries: string[] = [];
  let resolvedCount = 0;
  for (const [path, pathEntries] of byPath) {
    let fileContent = await readOpenDocumentText(await resolveWorkspaceFile(path), Number.MAX_SAFE_INTEGER);
    const resolvedIds: number[] = [];
    for (const entry of pathEntries.sort((left, right) => right.startLine - left.startLine)) {
      const replacement = expandConflictTokens(content, entry);
      fileContent = spliceConflict(fileContent, entry, replacement);
      resolvedIds.push(entry.id);
    }
    const uri = await resolveWorkspaceFile(path);
    await writeText(uri, fileContent);
    for (const id of resolvedIds) ctx.conflicts.remove(id);
    resolvedCount += resolvedIds.length;
    summaries.push(`${path}: ${resolvedIds.length} conflict${resolvedIds.length === 1 ? "" : "s"}`);
  }

  return [`Resolved ${resolvedCount} conflict${resolvedCount === 1 ? "" : "s"} across ${summaries.length} file${summaries.length === 1 ? "" : "s"}:`, ...summaries.map((item) => `- ${item}`)].join("\n");
}

async function resolveConflictEntry(entry: ConflictEntry, content: string, ctx: Parameters<ToolDefinition["run"]>[1]): Promise<string> {
  const uri = await resolveWorkspaceFile(entry.path);
  const original = await readOpenDocumentText(uri, Number.MAX_SAFE_INTEGER);
  const replacement = expandConflictTokens(content, entry);
  const next = spliceConflict(original, entry, replacement);
  await writeText(uri, next);
  ctx.conflicts.remove(entry.id);
  const path = relativePath(uri);
  const snapshot = ctx.snapshots.record(path, next);
  const diagnostics = await postMutationDiagnostics(uri, { settingKey: "write.diagnosticsOnWrite" });
  return [diagnostics, renderAnchoredFileWithTag(path, next, snapshot.tag)].filter((item): item is string => Boolean(item)).join("\n\n");
}

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

async function runPostWriteHooks(uri: vscode.Uri): Promise<{ content?: string; formatted: boolean; diagnostics?: string; madeExecutable: boolean }> {
  const config = vscode.workspace.getConfiguration("alpha");
  const formatOnWrite = config.get<boolean>("write.formatOnWrite", false);
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

  const madeExecutable = await maybeMarkExecutable(uri, document.getText());
  const diagnostics = await postMutationDiagnostics(uri, { settingKey: "write.diagnosticsOnWrite" });
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
