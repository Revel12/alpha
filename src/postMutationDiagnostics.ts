import * as vscode from "vscode";
import { structuralDiagnostics } from "./pythonStaticChecks";
import { relativePath } from "./workspace";

export interface PostMutationDiagnosticsOptions {
  settingKey: "edit.diagnosticsOnEdit" | "write.diagnosticsOnWrite";
  waitMs?: number;
  limit?: number;
}

const DEFAULT_WAIT_MS = 350;
const DEFAULT_LIMIT = 8;

export async function postMutationDiagnostics(uri: vscode.Uri, options: PostMutationDiagnosticsOptions): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("alpha");
  if (config.get<boolean>(options.settingKey, true) !== true) return undefined;

  const waitMs = Math.max(0, Math.min(3000, options.waitMs ?? DEFAULT_WAIT_MS));
  const limit = Math.max(1, Math.min(50, options.limit ?? DEFAULT_LIMIT));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  if (waitMs > 0) await delay(waitMs);

  const displayPath = relativePath(uri);
  return formatPostMutationDiagnostics(
    displayPath,
    vscode.languages.getDiagnostics(uri),
    limit,
    structuralDiagnostics(displayPath, document.getText()),
  );
}

export function formatPostMutationDiagnostics(
  displayPath: string,
  diagnostics: vscode.Diagnostic[],
  limit = DEFAULT_LIMIT,
  structural: string[] = [],
): string | undefined {
  if (!diagnostics.length && !structural.length) return "Diagnostics after mutation: OK.";

  const bySeverity = new Map<vscode.DiagnosticSeverity, number>();
  for (const diagnostic of diagnostics) {
    bySeverity.set(diagnostic.severity, (bySeverity.get(diagnostic.severity) ?? 0) + 1);
  }

  const summary = [
    plural(bySeverity.get(vscode.DiagnosticSeverity.Error) ?? 0, "error"),
    plural(bySeverity.get(vscode.DiagnosticSeverity.Warning) ?? 0, "warning"),
    plural(bySeverity.get(vscode.DiagnosticSeverity.Information) ?? 0, "info"),
    plural(bySeverity.get(vscode.DiagnosticSeverity.Hint) ?? 0, "hint"),
  ].join(", ");
  const examples = diagnostics.slice(0, limit).map((diagnostic) => {
    const line = diagnostic.range.start.line + 1;
    const column = diagnostic.range.start.character + 1;
    const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
    return `- ${displayPath}:${line}:${column} ${severityName(diagnostic.severity)}${source}: ${diagnostic.message}`;
  });
  const more = diagnostics.length > limit ? [`- ... ${diagnostics.length - limit} more diagnostic(s)`] : [];
  const structuralLines = structural.length
    ? ["", "Alpha static checks after mutation:", ...structural.slice(0, limit), ...(structural.length > limit ? [`- ... ${structural.length - limit} more static check(s)`] : [])]
    : [];
  return [`Diagnostics after mutation: ${summary}.`, ...examples, ...more, ...structuralLines].join("\n");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function severityName(severity: vscode.DiagnosticSeverity): string {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
