export type LspAction =
  | "diagnostics"
  | "definition"
  | "references"
  | "hover"
  | "symbols"
  | "rename"
  | "rename_file"
  | "code_actions"
  | "type_definition"
  | "implementation"
  | "status"
  | "reload"
  | "capabilities"
  | "request";

export interface LspInput {
  action: LspAction;
  file?: string;
  line?: number;
  symbol?: string;
  query?: string;
  new_name?: string;
  apply?: boolean;
  timeout?: number;
  payload?: string;
}

export interface LspLocation {
  path: string;
  line: number;
  column: number;
  context?: string;
}

export interface LspDiagnostic {
  path: string;
  line: number;
  column: number;
  severity: string;
  message: string;
  source?: string;
}

export interface LspStatusDocument {
  path: string;
  languageId: string;
  diagnostics: LspDiagnostic[];
}

export interface LspStatusInput {
  openDocuments: LspStatusDocument[];
  workspaceDiagnosticCount: number;
  openLanguageIds: Iterable<string>;
  installedExtensionIds: Iterable<string>;
}

export interface LspWorkspaceEditItem {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  oldText?: string;
  newText: string;
}

export interface LspCodeActionItem {
  index: number;
  title: string;
  kind?: string;
  disabledReason?: string;
  diagnosticCount?: number;
  editCount?: number;
  hasCommand?: boolean;
}

export interface LspProfile {
  name: string;
  ompServer: string;
  fileTypes: string[];
  languageIds: string[];
  suggestedExtensions: string[];
  rootMarkers: string[];
}

export const OMP_IAC_LSP_PROFILES: readonly LspProfile[] = [
  {
    name: "YAML",
    ompServer: "yamlls",
    fileTypes: [".yaml", ".yml"],
    languageIds: ["yaml"],
    suggestedExtensions: ["redhat.vscode-yaml"],
    rootMarkers: [".git"],
  },
  {
    name: "Terraform",
    ompServer: "terraformls",
    fileTypes: [".tf", ".tfvars"],
    languageIds: ["terraform", "terraform-vars"],
    suggestedExtensions: ["hashicorp.terraform"],
    rootMarkers: [".terraform", "terraform.tfstate", "*.tf"],
  },
  {
    name: "Dockerfile",
    ompServer: "dockerls",
    fileTypes: [".dockerfile", "Dockerfile"],
    languageIds: ["dockerfile"],
    suggestedExtensions: ["ms-azuretools.vscode-docker"],
    rootMarkers: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", ".dockerignore"],
  },
  {
    name: "Helm",
    ompServer: "helm-ls",
    fileTypes: [".yaml", ".yml", ".tpl"],
    languageIds: ["helm", "yaml"],
    suggestedExtensions: ["vscode-helm", "redhat.vscode-yaml"],
    rootMarkers: ["Chart.yaml", "Chart.yml"],
  },
];

const LSP_ACTIONS = new Set<LspAction>([
  "diagnostics",
  "definition",
  "references",
  "hover",
  "symbols",
  "rename",
  "rename_file",
  "code_actions",
  "type_definition",
  "implementation",
  "status",
  "reload",
  "capabilities",
  "request",
]);

export function parseLspInput(args: string): LspInput {
  const raw = JSON.parse(args) as Partial<LspInput>;
  const action = typeof raw.action === "string" ? raw.action : "";
  if (!LSP_ACTIONS.has(action as LspAction)) throw new Error(`Unsupported lsp action: ${action || "(missing)"}`);
  return {
    action: action as LspAction,
    file: typeof raw.file === "string" ? raw.file : undefined,
    line: typeof raw.line === "number" && Number.isFinite(raw.line) ? Math.max(1, Math.trunc(raw.line)) : undefined,
    symbol: typeof raw.symbol === "string" ? raw.symbol : undefined,
    query: typeof raw.query === "string" ? raw.query : undefined,
    new_name: typeof raw.new_name === "string" ? raw.new_name : undefined,
    apply: typeof raw.apply === "boolean" ? raw.apply : undefined,
    timeout: typeof raw.timeout === "number" && Number.isFinite(raw.timeout) ? clamp(raw.timeout, 5, 60) : undefined,
    payload: typeof raw.payload === "string" ? raw.payload : undefined,
  };
}

export function formatLocations(kind: string, locations: LspLocation[], contextLimit = 50): string {
  if (!locations.length) return `No ${kind} found`;
  const contextual = locations.slice(0, contextLimit);
  const plain = locations.slice(contextLimit);
  const lines = contextual.map(formatLocation);
  if (plain.length > 0) {
    lines.push(`  ... ${plain.length} additional ${kind}(s) shown without context`);
    lines.push(...plain.map((location) => `  ${location.path}:${location.line}:${location.column}`));
  }
  return `Found ${locations.length} ${kind}(s):\n${lines.join("\n")}`;
}

export function formatDiagnostics(diagnostics: LspDiagnostic[]): string {
  if (!diagnostics.length) return "OK";
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    counts.set(diagnostic.severity, (counts.get(diagnostic.severity) ?? 0) + 1);
  }
  const summary = ["Error", "Warning", "Information", "Hint"]
    .map((severity) => {
      const count = counts.get(severity) ?? 0;
      return count > 0 ? `${count} ${severity.toLowerCase()}${count === 1 ? "" : "s"}` : undefined;
    })
    .filter((value): value is string => typeof value === "string")
    .join(", ");
  return `${summary || `${diagnostics.length} diagnostic(s)`}:\n${diagnostics.map(formatDiagnostic).join("\n")}`;
}

export function unsupportedLspAction(action: LspAction, reason: string): string {
  return `Unsupported lsp action '${action}' in Alpha: ${reason}`;
}

export function formatLspStatus(input: LspStatusInput): string {
  const languages = [...new Set([...input.openLanguageIds].filter(Boolean))].sort();
  const openDocuments = input.openDocuments.slice().sort((left, right) => {
    const byLanguage = left.languageId.localeCompare(right.languageId);
    return byLanguage || left.path.localeCompare(right.path);
  });
  const filesWithDiagnostics = openDocuments.filter((document) => document.diagnostics.length > 0);
  const diagnosticsByLanguage = new Map<string, LspDiagnostic[]>();
  for (const document of openDocuments) {
    const current = diagnosticsByLanguage.get(document.languageId) ?? [];
    current.push(...document.diagnostics);
    diagnosticsByLanguage.set(document.languageId, current);
  }

  const lines = [
    "VS Code language features are available through registered extensions.",
    languages.length ? `Open document languages: ${languages.join(", ")}` : "No open text document languages detected.",
    `Current workspace diagnostics: ${input.workspaceDiagnosticCount}`,
    "",
    "Open-file diagnostics by language:",
  ];

  if (openDocuments.length === 0) {
    lines.push("- No open text documents.");
  } else {
    for (const language of [...diagnosticsByLanguage.keys()].sort()) {
      const diagnostics = diagnosticsByLanguage.get(language) ?? [];
      lines.push(`- ${language}: ${diagnostics.length} diagnostic(s)`);
      const documents = openDocuments.filter((document) => document.languageId === language);
      for (const document of documents) {
        const summary = summarizeDiagnostics(document.diagnostics);
        lines.push(`  - ${document.path}: ${summary}`);
      }
    }
  }

  if (filesWithDiagnostics.length > 0) {
    lines.push("", "Open files with diagnostics:");
    for (const document of filesWithDiagnostics.slice(0, 50)) {
      lines.push(`- ${document.path} (${document.languageId}): ${summarizeDiagnostics(document.diagnostics)}`);
    }
    if (filesWithDiagnostics.length > 50) {
      lines.push(`- ... ${filesWithDiagnostics.length - 50} more open files with diagnostics`);
    }
  }

  lines.push(
    "",
    "OMP IaC language-server parity targets:",
    formatIacLspStatus(input.openLanguageIds, input.installedExtensionIds),
    "Note: VS Code does not expose raw language server process status to Alpha.",
  );
  return lines.join("\n");
}

export function formatIacLspStatus(openLanguageIds: Iterable<string>, installedExtensionIds: Iterable<string>): string {
  const open = new Set([...openLanguageIds].map((item) => item.toLowerCase()));
  const installed = new Set([...installedExtensionIds].map((item) => item.toLowerCase()));

  return OMP_IAC_LSP_PROFILES.map((profile) => {
    const languageActive = profile.languageIds.some((languageId) => open.has(languageId.toLowerCase()));
    const extensionInstalled = profile.suggestedExtensions.some((extensionId) => installed.has(extensionId.toLowerCase()));
    return [
      `- ${profile.name}: OMP default ${profile.ompServer} (${profile.fileTypes.join(", ")})`,
      `  VS Code language active: ${languageActive ? "yes" : "no"}`,
      `  Suggested extension installed: ${extensionInstalled ? "yes" : "no"} (${profile.suggestedExtensions.join(", ")})`,
      `  Root markers: ${profile.rootMarkers.join(", ")}`,
    ].join("\n");
  }).join("\n");
}

export function formatWorkspaceEditPreview(title: string, edits: LspWorkspaceEditItem[], limit = 80): string {
  if (edits.length === 0) return `${title}: no edits`;
  const grouped = new Map<string, LspWorkspaceEditItem[]>();
  for (const edit of edits) {
    const current = grouped.get(edit.path) ?? [];
    current.push(edit);
    grouped.set(edit.path, current);
  }

  const lines = [`${title}: ${edits.length} edit(s) across ${grouped.size} file(s)`];
  let rendered = 0;
  for (const [filePath, fileEdits] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (rendered >= limit) break;
    lines.push(`# ${filePath}`);
    for (const edit of fileEdits.sort((left, right) => left.line - right.line || left.column - right.column)) {
      if (rendered >= limit) break;
      const location = `${edit.line}:${edit.column}-${edit.endLine}:${edit.endColumn}`;
      lines.push(`- ${location}`);
      if (edit.oldText !== undefined) lines.push(`  old: ${formatSnippet(edit.oldText)}`);
      lines.push(`  new: ${formatSnippet(edit.newText)}`);
      rendered++;
    }
  }

  if (edits.length > rendered) lines.push(`... ${edits.length - rendered} additional edit(s) omitted from preview`);
  return lines.join("\n");
}

export function formatCodeActions(actions: LspCodeActionItem[]): string {
  if (actions.length === 0) return "No code actions available";
  return actions.map((action) => {
    const details = [
      action.kind ? `kind=${action.kind}` : undefined,
      action.diagnosticCount !== undefined ? `diagnostics=${action.diagnosticCount}` : undefined,
      action.editCount !== undefined ? `edits=${action.editCount}` : undefined,
      action.hasCommand ? "command=yes" : undefined,
      action.disabledReason ? `disabled=${action.disabledReason}` : undefined,
    ].filter((item): item is string => typeof item === "string");
    return `${action.index}: ${action.title}${details.length ? ` (${details.join(", ")})` : ""}`;
  }).join("\n");
}

export function selectCodeActionIndex(actions: LspCodeActionItem[], query: string | undefined): number | undefined {
  if (actions.length === 0) return undefined;
  const trimmed = query?.trim() ?? "";
  if (!trimmed) return actions.find((action) => !action.disabledReason)?.index;
  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    return actions.some((action) => action.index === index) ? index : undefined;
  }

  const lowered = trimmed.toLowerCase();
  const kindQuery = lowered.match(/^kind:(.+)$/)?.[1]?.trim();
  const candidates = actions.filter((action) => !action.disabledReason);
  if (kindQuery) {
    return candidates.find((action) => action.kind?.toLowerCase() === kindQuery)?.index
      ?? candidates.find((action) => action.kind?.toLowerCase().includes(kindQuery))?.index;
  }

  const scored = candidates
    .map((action) => ({ action, score: scoreCodeAction(action, lowered) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.action.index - right.action.index);
  return scored[0]?.action.index;
}

function formatLocation(location: LspLocation): string {
  const head = `  ${location.path}:${location.line}:${location.column}`;
  return location.context ? `${head}\n${indent(location.context)}` : head;
}

function formatDiagnostic(diagnostic: LspDiagnostic): string {
  const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
  return `- ${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}${source}: ${diagnostic.message}`;
}

function summarizeDiagnostics(diagnostics: LspDiagnostic[]): string {
  if (diagnostics.length === 0) return "OK";
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) counts.set(diagnostic.severity, (counts.get(diagnostic.severity) ?? 0) + 1);
  return ["Error", "Warning", "Information", "Hint"]
    .map((severity) => {
      const count = counts.get(severity) ?? 0;
      return count ? `${count} ${severity.toLowerCase()}${count === 1 ? "" : "s"}` : undefined;
    })
    .filter((item): item is string => typeof item === "string")
    .join(", ");
}

function formatSnippet(value: string): string {
  const normalized = value.replace(/\r?\n/g, "\\n");
  return JSON.stringify(normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized);
}

function scoreCodeAction(action: LspCodeActionItem, query: string): number {
  const title = action.title.toLowerCase();
  const kind = action.kind?.toLowerCase() ?? "";
  if (title === query) return 100;
  if (kind === query) return 95;
  if (title.startsWith(query)) return 80;
  if (kind.startsWith(query)) return 70;
  if (title.includes(query)) return 60;
  if (kind.includes(query)) return 50;
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((word) => title.includes(word) || kind.includes(word))) return 40;
  return 0;
}

function indent(value: string): string {
  return value.split(/\r?\n/).map((line) => `    ${line}`).join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
