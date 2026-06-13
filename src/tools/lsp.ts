import * as vscode from "vscode";
import { ensureToolPermission } from "../approval";
import { lspApproval, lspApprovalDetails } from "../approvalCore";
import {
  formatCodeActions,
  formatDiagnostics,
  formatLocations,
  formatLspStatus,
  formatWorkspaceEditPreview,
  parseLspInput,
  selectCodeActionIndex,
  unsupportedLspAction,
} from "../lspCore";
import type { LspCodeActionItem, LspDiagnostic, LspInput, LspLocation, LspWorkspaceEditItem } from "../lspCore";
import type { ToolDefinition } from "../types";
import { readOpenDocumentText, relativePath, resolveExistingWorkspacePath } from "../workspace";

export const lspTool: ToolDefinition = {
  name: "lsp",
  summary: "Query VS Code language features for diagnostics, definitions, hover, symbols, references, rename, and code actions.",
  async run(args, ctx) {
    const input = parseLspInput(args);
    await ensureToolPermission(
      { name: "lsp", approval: lspApproval, formatApprovalDetails: lspApprovalDetails },
      input,
      ctx,
    );

    switch (input.action) {
      case "status":
        return { markdown: statusOutput() };
      case "diagnostics":
        return { markdown: await diagnosticsOutput(input) };
      case "definition":
        return { markdown: await locationOutput(input, "definition", "vscode.executeDefinitionProvider") };
      case "type_definition":
        return { markdown: await locationOutput(input, "type definition", "vscode.executeTypeDefinitionProvider") };
      case "implementation":
        return { markdown: await locationOutput(input, "implementation", "vscode.executeImplementationProvider") };
      case "references":
        return { markdown: await locationOutput(input, "reference", "vscode.executeReferenceProvider") };
      case "hover":
        return { markdown: await hoverOutput(input) };
      case "symbols":
        return { markdown: await symbolsOutput(input) };
      case "rename":
        return { markdown: await renameOutput(input) };
      case "code_actions":
        return { markdown: await codeActionsOutput(input) };
      case "rename_file":
        return { markdown: unsupportedLspAction(input.action, "VS Code does not expose workspace/willRenameFiles as a callable language feature command to chat participants.") };
      case "reload":
        return { markdown: unsupportedLspAction(input.action, "VS Code owns language server lifecycle; Alpha cannot restart arbitrary language servers through the stable API.") };
      case "capabilities":
        return { markdown: unsupportedLspAction(input.action, "VS Code does not expose raw per-server LSP capabilities through the stable extension API.") };
      case "request":
        return { markdown: unsupportedLspAction(input.action, "VS Code does not expose raw LSP request dispatch through the stable extension API.") };
    }
  },
};

function statusOutput(): string {
  const languages = new Set(vscode.workspace.textDocuments.map((document) => document.languageId).filter(Boolean));
  const installedExtensions = vscode.extensions.all.map((extension) => extension.id);
  const diagnostics = vscode.languages.getDiagnostics();
  const diagnosticCount = diagnostics.reduce((sum, [, items]) => sum + items.length, 0);
  const openDocuments = vscode.workspace.textDocuments
    .filter((document) => document.uri.scheme === "file")
    .map((document) => ({
      path: relativePath(document.uri),
      languageId: document.languageId || "plaintext",
      diagnostics: vscode.languages.getDiagnostics(document.uri).map((diagnostic) => toLspDiagnostic(document.uri, diagnostic)),
    }));
  return formatLspStatus({
    openDocuments,
    workspaceDiagnosticCount: diagnosticCount,
    openLanguageIds: languages,
    installedExtensionIds: installedExtensions,
  });
}

async function diagnosticsOutput(input: LspInput): Promise<string> {
  if (input.file === "*") {
    const all = vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => diagnostics.map((diagnostic) => toLspDiagnostic(uri, diagnostic)));
    return `Workspace diagnostics:\n${formatDiagnostics(all)}`;
  }
  const { uri } = await openRequiredDocument(input);
  return formatDiagnostics(vscode.languages.getDiagnostics(uri).map((diagnostic) => toLspDiagnostic(uri, diagnostic)));
}

async function locationOutput(input: LspInput, kind: string, command: string): Promise<string> {
  const { uri, position } = await positionTarget(input);
  const raw = await vscode.commands.executeCommand<unknown>(command, uri, position);
  const locations = await normalizeLocations(raw);
  return formatLocations(kind, locations);
}

async function hoverOutput(input: LspInput): Promise<string> {
  const { uri, position } = await positionTarget(input);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, position);
  const parts = (hovers ?? []).flatMap((hover) => hover.contents.map(markedStringToText)).filter((text) => text.trim().length > 0);
  return parts.length ? parts.join("\n\n") : "No hover information";
}

async function symbolsOutput(input: LspInput): Promise<string> {
  if (input.file === "*" || !input.file) {
    const query = input.query ?? "";
    if (!query.trim()) return "Error: query parameter required for workspace symbols.";
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query);
    if (!symbols?.length) return "No symbols found";
    return symbols.slice(0, 200).map((symbol) => `${symbolKindName(symbol.kind)} ${symbol.name} ${relativePath(symbol.location.uri)}:${symbol.location.range.start.line + 1}:${symbol.location.range.start.character + 1}`).join("\n");
  }

  const { uri } = await openRequiredDocument(input);
  const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>("vscode.executeDocumentSymbolProvider", uri);
  if (!symbols?.length) return "No symbols found";
  return flattenSymbols(symbols).slice(0, 200).join("\n");
}

async function renameOutput(input: LspInput): Promise<string> {
  if (!input.new_name?.trim()) return "Error: rename requires new_name.";
  const { uri, position } = await positionTarget(input);
  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", uri, position, input.new_name);
  if (!edit) return "No rename edit available";
  const entries = await workspaceEditEntries(edit);
  if (!entries.length) return "No rename edits returned";
  if (input.apply === false) {
    return formatWorkspaceEditPreview(`Rename preview for ${input.new_name}`, entries);
  }
  const ok = await vscode.workspace.applyEdit(edit);
  return ok ? `Applied rename to ${input.new_name} (${entries.length} edit(s)).` : "VS Code rejected rename workspace edit.";
}

async function codeActionsOutput(input: LspInput): Promise<string> {
  const { uri, position } = await positionTarget(input);
  const range = new vscode.Range(position, position);
  const actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>("vscode.executeCodeActionProvider", uri, range);
  if (!actions?.length) return "No code actions available";
  const indexed = actions.map(toCodeActionItem);

  if (input.apply === true) {
    const selectedIndex = selectCodeActionIndex(indexed, input.query);
    if (selectedIndex === undefined) return `No matching enabled code action found.\n\n${formatCodeActions(indexed)}`;
    const selectedMeta = indexed.find((action) => action.index === selectedIndex);
    if (selectedMeta?.disabledReason) return `Selected code action is disabled: ${selectedMeta.disabledReason}`;
    const selected = actions[selectedIndex];
    if (!selected) return "No matching code action found";
    if (isCodeAction(selected) && selected.edit) {
      const ok = await vscode.workspace.applyEdit(selected.edit);
      if (!ok) return "VS Code rejected code action workspace edit.";
    }
    const command = isCodeAction(selected) ? selected.command : selected;
    if (command) await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    return `Applied code action: ${codeActionTitle(selected)}`;
  }

  return formatCodeActions(indexed);
}

async function positionTarget(input: LspInput): Promise<{ uri: vscode.Uri; position: vscode.Position }> {
  const uri = await requiredFile(input);
  if (!input.line) throw new Error(`lsp ${input.action} requires line.`);
  const document = await vscode.workspace.openTextDocument(uri);
  const lineIndex = Math.max(0, Math.min(document.lineCount - 1, input.line - 1));
  const column = input.symbol ? resolveSymbolColumn(document.lineAt(lineIndex).text, input.symbol) : 0;
  return { uri, position: new vscode.Position(lineIndex, column) };
}

async function requiredFile(input: LspInput): Promise<vscode.Uri> {
  if (!input.file || input.file === "*") throw new Error(`lsp ${input.action} requires file.`);
  return resolveExistingWorkspacePath(input.file);
}

async function openRequiredDocument(input: LspInput): Promise<{ uri: vscode.Uri; document: vscode.TextDocument }> {
  const uri = await requiredFile(input);
  const document = await vscode.workspace.openTextDocument(uri);
  return { uri, document };
}

function resolveSymbolColumn(line: string, symbolWithSelector: string): number {
  const match = symbolWithSelector.match(/^(.*)#(\d+)$/);
  const symbol = match ? match[1] : symbolWithSelector;
  const occurrence = match ? Math.max(1, Number.parseInt(match[2], 10)) : 1;
  if (!symbol) return 0;
  let from = 0;
  for (let count = 1; count <= occurrence; count++) {
    const found = line.indexOf(symbol, from);
    if (found === -1) throw new Error(`Symbol '${symbolWithSelector}' not found on target line.`);
    if (count === occurrence) return found;
    from = found + symbol.length;
  }
  return 0;
}

async function normalizeLocations(raw: unknown): Promise<LspLocation[]> {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: LspLocation[] = [];
  for (const item of list) {
    const location = item as vscode.Location | vscode.LocationLink;
    const isLink = "targetUri" in location;
    const uri = isLink ? location.targetUri : location.uri;
    const range = isLink ? location.targetSelectionRange ?? location.targetRange : location.range;
    out.push(await toLspLocation(uri, range.start));
  }
  return out;
}

async function toLspLocation(uri: vscode.Uri, position: vscode.Position): Promise<LspLocation> {
  const path = relativePath(uri);
  const line = position.line + 1;
  const column = position.character + 1;
  let context: string | undefined;
  try {
    const text = await readOpenDocumentText(uri, 300000);
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, position.line - 1);
    const end = Math.min(lines.length - 1, position.line + 1);
    context = lines.slice(start, end + 1).map((value, index) => `${start + index + 1}:${value}`).join("\n");
  } catch {
    context = undefined;
  }
  return { path, line, column, context };
}

function toLspDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic): LspDiagnostic {
  return {
    path: relativePath(uri),
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    severity: diagnosticSeverity(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source,
  };
}

function diagnosticSeverity(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "Error";
    case vscode.DiagnosticSeverity.Warning:
      return "Warning";
    case vscode.DiagnosticSeverity.Information:
      return "Information";
    case vscode.DiagnosticSeverity.Hint:
      return "Hint";
  }
}

function markedStringToText(value: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof value === "string") return value;
  if ("language" in value) return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  return value.value;
}

function flattenSymbols(symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[], depth = 0): string[] {
  const lines: string[] = [];
  for (const symbol of symbols) {
    if ("children" in symbol) {
      lines.push(`${"  ".repeat(depth)}${symbolKindName(symbol.kind)} ${symbol.name} ${symbol.range.start.line + 1}:${symbol.range.start.character + 1}`);
      lines.push(...flattenSymbols(symbol.children, depth + 1));
    } else {
      lines.push(`${symbolKindName(symbol.kind)} ${symbol.name} ${relativePath(symbol.location.uri)}:${symbol.location.range.start.line + 1}:${symbol.location.range.start.character + 1}`);
    }
  }
  return lines;
}

async function workspaceEditEntries(edit: vscode.WorkspaceEdit): Promise<LspWorkspaceEditItem[]> {
  const entries: LspWorkspaceEditItem[] = [];
  for (const [uri, edits] of edit.entries()) {
    let document: vscode.TextDocument | undefined;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      document = undefined;
    }
    for (const item of edits) {
      entries.push({
        path: relativePath(uri),
        line: item.range.start.line + 1,
        column: item.range.start.character + 1,
        endLine: item.range.end.line + 1,
        endColumn: item.range.end.character + 1,
        oldText: document?.getText(item.range),
        newText: item.newText,
      });
    }
  }
  return entries;
}

function codeActionTitle(action: vscode.CodeAction | vscode.Command): string {
  return action.title;
}

function toCodeActionItem(action: vscode.CodeAction | vscode.Command, index: number): LspCodeActionItem {
  if (!isCodeAction(action)) {
    return {
      index,
      title: action.title,
      hasCommand: true,
    };
  }
  return {
    index,
    title: action.title,
    kind: action.kind?.value,
    disabledReason: action.disabled?.reason,
    diagnosticCount: action.diagnostics?.length,
    editCount: action.edit?.entries().reduce((sum, [, edits]) => sum + edits.length, 0),
    hasCommand: Boolean(action.command),
  };
}

function isCodeAction(action: vscode.CodeAction | vscode.Command): action is vscode.CodeAction {
  return "edit" in action || "diagnostics" in action || "kind" in action;
}

function symbolKindName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? "Symbol";
}
