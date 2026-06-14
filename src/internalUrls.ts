import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as vscode from "vscode";
import { applyJsonPath } from "./jsonPath";
import { renderTranscriptMarkdown } from "./transcript";
import type { AlphaContext } from "./types";
import { readText, resolveWorkspaceFile, stat } from "./workspace";

export interface InternalResource {
  url: string;
  label: string;
  content: string;
  contentType: "text/markdown" | "application/json" | "text/plain";
  size: number;
  sourcePath?: string;
  immutable: boolean;
  kind: "artifact" | "history" | "local" | "memory" | "omp" | "pr" | "agent" | "skill" | "rule" | "issue" | "mcp" | "vault";
}

interface ParsedInternalUrl {
  scheme: InternalResource["kind"];
  path: string;
  query: URLSearchParams;
}

const INTERNAL_SCHEMES = new Set(["artifact", "history", "local", "memory", "omp", "pr", "agent", "skill", "rule", "issue", "mcp", "vault"]);

const OMP_DOCS: Record<string, string> = {
  "tools/read.md": [
    "# read",
    "",
    "Reads workspace files, active editor content, directories, and internal URLs.",
    "",
    "Internal URLs supported by Alpha:",
    "- artifact:// for full stored tool outputs",
    "- history:// for current Alpha chat/session history",
    "- local:// for session-local scratch files",
    "- memory://root for local memory-summary shims",
    "- omp://docs and omp://tools/* for bundled parity notes",
    "- pr://<N> and pr://<N>/diff for Bitbucket pull request views",
    "- agent://<id> and agent://<id>/<json.path> for Alpha task outputs",
    "- skill://<name> and rule://<name> for local project/user guidance files",
  ].join("\n"),
  "tools/bash.md": [
    "# bash",
    "",
    "Runs workspace shell commands through the VS Code extension host.",
    "",
    "Long visible output is truncated in chat, while the full raw output is stored and recoverable through artifact://.",
    "Commands that should use dedicated tools, such as read/search/find/edit/write, are intercepted by default.",
  ].join("\n"),
  "tools/write.md": [
    "# write",
    "",
    "Writes a complete workspace file, a session-local local:// scratch file, an archive member, or a SQLite row.",
    "",
    "Use edit for routine changes to existing workspace files. Use write for new files, total rewrites, local:// artifacts, archive entries, and SQLite row operations.",
    "",
    "Archive targets use archive.ext:path/in/archive for .zip, .tar, .tar.gz, and .tgz.",
    "SQLite targets use db.sqlite:table to insert JSON objects and db.sqlite:table:key to update or delete rows.",
  ].join("\n"),
  "tools/edit.md": [
    "# edit",
    "",
    "Applies hash-anchored edits to previously read workspace files.",
    "",
    "Alpha validates the file tag before applying changes, mirroring OMP-style hash editing where the VS Code API allows it.",
  ].join("\n"),
  "urls.md": [
    "# internal URLs",
    "",
    "Alpha resolves internal URLs through read so model-facing tools can recover hidden or long-lived context.",
    "",
    "- artifact://<id> reads a stored full tool result.",
    "- history:// lists the current session; history://current reads the current transcript.",
    "- local:// lists session-local scratch files; local://<path> reads one.",
    "- memory://root reads .alpha/memory/memory_summary.md when present.",
    "- omp://docs lists bundled OMP parity notes.",
    "- pr://<N> reads Bitbucket PR metadata; pr://<N>/diff reads the unified diff.",
    "- agent://<id> reads a task output; agent://<id>/findings.0.path extracts JSON fields.",
    "- skill:// and rule:// list locally discoverable skills/rules.",
  ].join("\n"),
};

export function isInternalUrlPath(input: string): boolean {
  const parsed = tryParseInternalUrl(input);
  return parsed !== undefined;
}

export async function resolveInternalUrl(input: string, ctx: AlphaContext): Promise<InternalResource> {
  const parsed = parseInternalUrl(input);
  switch (parsed.scheme) {
    case "artifact":
      return resolveArtifactUrl(parsed, ctx);
    case "history":
      return resolveHistoryUrl(parsed, ctx);
    case "local":
      return resolveLocalUrl(parsed, ctx);
    case "memory":
      return resolveMemoryUrl(parsed);
    case "omp":
      return resolveOmpUrl(parsed);
    case "pr":
      return resolvePrUrl(parsed, ctx);
    case "agent":
      return resolveAgentUrl(parsed, ctx);
    case "skill":
      return resolveNamedFileUrl(parsed, "skill");
    case "rule":
      return resolveNamedFileUrl(parsed, "rule");
    case "issue":
      return resolveUnsupportedKnownScheme(parsed, "Bitbucket/Jira issue URL reads are not configured in Alpha. Use the approved tracker or Bitbucket/Jira UI for issues.");
    case "mcp":
      return resolveUnsupportedKnownScheme(parsed, "mcp:// requires OMP's MCP runtime/host URI bridge, which is not exposed to this VS Code chat participant.");
    case "vault":
      return resolveUnsupportedKnownScheme(parsed, "vault:// requires OMP's vault backend. Alpha does not provide a vault store in the VS Code chat participant.");
  }
  const exhaustive: never = parsed.scheme;
  throw new Error(`Unsupported internal URL scheme: ${exhaustive}`);
}

function resolveAgentUrl(parsed: ParsedInternalUrl, ctx: AlphaContext): InternalResource {
  const { id, extraction } = splitAgentPath(parsed.path);
  if (!id) throw new Error("agent:// URL requires an output ID: agent://<id>");
  const artifact = resolveAgentArtifact(id, ctx);
  if (!artifact) {
    const available = ctx.artifacts.list()
      .map((item) => agentIdFromArtifactLabel(item.label))
      .filter((item): item is string => Boolean(item));
    throw new Error(`Agent output not found: agent://${id}. Available: ${available.length ? available.join(", ") : "none"}`);
  }

  let content = artifact.content;
  let contentType: InternalResource["contentType"] = "text/markdown";
  const queryExtraction = parsed.query.get("q") ?? undefined;
  if (extraction && queryExtraction) {
    throw new Error("agent:// URL cannot combine path extraction with ?q=");
  }
  const requestedExtraction = extraction || queryExtraction;
  if (requestedExtraction) {
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`agent://${id} output is not valid JSON: ${message}`);
    }
    const extracted = applyJsonPath(json, requestedExtraction);
    content = JSON.stringify(extracted ?? null, null, 2);
    contentType = "application/json";
  }

  return {
    url: requestedExtraction ? `agent://${id}/${requestedExtraction}` : `agent://${id}`,
    label: `agent://${id}`,
    content,
    contentType,
    size: Buffer.byteLength(content, "utf8"),
    sourcePath: artifact.filePath,
    immutable: true,
    kind: "agent",
  };
}

function splitAgentPath(input: string): { id: string; extraction?: string } {
  const rel = stripSlashes(input);
  const slash = rel.indexOf("/");
  if (slash === -1) return { id: rel };
  return {
    id: rel.slice(0, slash),
    extraction: rel.slice(slash + 1).replace(/^\/+/, ""),
  };
}

function resolveAgentArtifact(id: string, ctx: AlphaContext) {
  if (/^\d+$/.test(id)) return ctx.artifacts.get(id);
  const artifact = ctx.artifacts.list().find((item) => agentIdFromArtifactLabel(item.label) === id);
  return artifact ? ctx.artifacts.get(artifact.id) : undefined;
}

function agentIdFromArtifactLabel(label: string): string | undefined {
  const match = /^task\s+(.+?)\s+output$/i.exec(label.trim());
  return match?.[1];
}

async function resolveNamedFileUrl(parsed: ParsedInternalUrl, kind: "skill" | "rule"): Promise<InternalResource> {
  const rel = stripSlashes(parsed.path);
  const roots = kind === "skill" ? skillRoots() : ruleRoots();
  if (!rel) {
    const entries = await listNamedFiles(roots);
    const content = entries.length
      ? entries.map((entry) => `- ${kind}://${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`).join("\n")
      : `No ${kind}s found.`;
    return {
      url: `${kind}://`,
      label: `${kind}://`,
      content,
      contentType: "text/markdown",
      size: Buffer.byteLength(content, "utf8"),
      immutable: true,
      kind,
    };
  }

  const file = await findNamedFile(kind, rel, roots);
  if (!file) throw new Error(`${kind} not found: ${kind}://${rel}`);
  const content = await fs.readFile(file.path, "utf8");
  return {
    url: `${kind}://${rel}`,
    label: `${kind}://${rel}`,
    content,
    contentType: contentTypeForPath(file.path),
    size: Buffer.byteLength(content, "utf8"),
    sourcePath: file.path,
    immutable: true,
    kind,
  };
}

function resolveUnsupportedKnownScheme(parsed: ParsedInternalUrl, message: string): InternalResource {
  const content = [
    `# ${parsed.scheme}://`,
    "",
    message,
  ].join("\n");
  return {
    url: normalizeInternalUrl(parsed),
    label: normalizeInternalUrl(parsed),
    content,
    contentType: "text/markdown",
    size: Buffer.byteLength(content, "utf8"),
    immutable: true,
    kind: parsed.scheme,
  };
}

async function resolvePrUrl(parsed: ParsedInternalUrl, ctx: AlphaContext): Promise<InternalResource> {
  const { readBitbucketPrUrl } = await import("./tools/bitbucket.js");
  const resource = await readBitbucketPrUrl(parsed.path, ctx);
  return {
    ...resource,
    immutable: false,
    kind: "pr",
  };
}

export async function writeInternalUrl(input: string, content: string, ctx: AlphaContext): Promise<InternalResource> {
  const parsed = parseInternalUrl(input);
  if (parsed.scheme !== "local") {
    throw new Error(`Only local:// URLs are writable; got ${parsed.scheme}://.`);
  }

  const uri = localUriForPath(parsed.path, ctx, { allowEmpty: false });
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  return {
    url: normalizeInternalUrl(parsed),
    label: normalizeInternalUrl(parsed),
    content,
    contentType: contentTypeForPath(parsed.path),
    size: Buffer.byteLength(content, "utf8"),
    sourcePath: uri.fsPath,
    immutable: false,
    kind: "local",
  };
}

function resolveArtifactUrl(parsed: ParsedInternalUrl, ctx: AlphaContext): InternalResource {
  const id = stripSlashes(parsed.path);
  if (!id) {
    throw new Error("artifact:// URL requires a numeric ID: artifact://0");
  }
  if (!/^\d+$/.test(id)) {
    throw new Error(`artifact:// ID must be numeric, got: ${id}`);
  }

  const artifact = ctx.artifacts.get(id);
  if (!artifact) throw new Error(`Artifact not found: artifact://${id}`);
  const content = artifact.content;
  return {
    url: `artifact://${artifact.id}`,
    label: `artifact://${artifact.id} ${artifact.label}`,
    content,
    contentType: "text/plain",
    size: Buffer.byteLength(content, "utf8"),
    immutable: true,
    kind: "artifact",
  };
}

function resolveHistoryUrl(parsed: ParsedInternalUrl, ctx: AlphaContext): InternalResource {
  const target = stripSlashes(parsed.path);
  if (!target) {
    const content = [
      `current\t${ctx.sessionKey}\t${ctx.sessionLabel}`,
      "Use history://current to read the current Alpha transcript.",
    ].join("\n");
    return {
      url: "history://",
      label: "history://",
      content,
      contentType: "text/markdown",
      size: Buffer.byteLength(content, "utf8"),
      immutable: false,
      kind: "history",
    };
  }

  if (target !== "current" && target !== ctx.sessionKey) {
    throw new Error(`History URL ${normalizeInternalUrl(parsed)} is not available in this VS Code chat participant context.`);
  }

  const content = renderTranscriptMarkdown({
    title: ctx.sessionLabel,
    sessionKey: ctx.sessionKey,
    transcript: ctx.transcript,
  });
  return {
    url: target === "current" ? "history://current" : `history://${ctx.sessionKey}`,
    label: "history://current",
    content,
    contentType: "text/markdown",
    size: Buffer.byteLength(content, "utf8"),
    immutable: false,
    kind: "history",
  };
}

async function resolveLocalUrl(parsed: ParsedInternalUrl, ctx: AlphaContext): Promise<InternalResource> {
  const rel = stripSlashes(parsed.path);
  if (!rel) {
    const root = localRoot(ctx);
    await vscode.workspace.fs.createDirectory(root);
    const content = (await renderLocalTree(root, "", 0, 3, 400)).join("\n") || "No local artifacts.";
    return {
      url: "local://",
      label: "local://",
      content,
      contentType: "text/markdown",
      size: Buffer.byteLength(content, "utf8"),
      sourcePath: root.fsPath,
      immutable: false,
      kind: "local",
    };
  }

  const uri = localUriForPath(rel, ctx, { allowEmpty: false });
  const fileStat = await vscode.workspace.fs.stat(uri);
  if (fileStat.type === vscode.FileType.Directory) {
    throw new Error(`local:// URL must resolve to a file: local://${rel}`);
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const content = Buffer.from(bytes).toString("utf8");
  return {
    url: `local://${rel}`,
    label: `local://${rel}`,
    content,
    contentType: contentTypeForPath(rel),
    size: Buffer.byteLength(content, "utf8"),
    sourcePath: uri.fsPath,
    immutable: false,
    kind: "local",
  };
}

async function resolveMemoryUrl(parsed: ParsedInternalUrl): Promise<InternalResource> {
  const rel = stripSlashes(parsed.path);
  const parts = splitSafeRelativePath(rel, { allowEmpty: true });
  const namespace = parts[0] || "root";
  if (namespace !== "root") {
    throw new Error(`Unsupported memory namespace: ${namespace}. Alpha currently supports memory://root only.`);
  }

  const memoryPath = parts.slice(1).join("/") || "memory_summary.md";
  const candidates = [
    `.alpha/memory/${memoryPath}`,
    memoryPath === "memory_summary.md" ? ".alpha/memory_summary.md" : undefined,
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    const uri = await resolveWorkspaceFile(candidate);
    try {
      await stat(uri);
      const content = await readText(uri, Number.MAX_SAFE_INTEGER);
      return {
        url: `memory://root${memoryPath === "memory_summary.md" ? "" : `/${memoryPath}`}`,
        label: `memory://root/${memoryPath}`,
        content,
        contentType: contentTypeForPath(memoryPath),
        size: Buffer.byteLength(content, "utf8"),
        sourcePath: uri.fsPath,
        immutable: true,
        kind: "memory",
      };
    } catch {
      // Try the next supported memory location.
    }
  }

  throw new Error("No Alpha memory artifact found. Expected .alpha/memory/memory_summary.md or .alpha/memory_summary.md.");
}

function resolveOmpUrl(parsed: ParsedInternalUrl): InternalResource {
  let rel = stripSlashes(parsed.path) || "docs";
  if (rel === "docs" || rel === "docs/") {
    const docs = Object.keys(OMP_DOCS).sort();
    const content = `# Documentation\n\n${docs.length} files available:\n\n${docs.map((doc) => `- [${doc}](omp://${doc})`).join("\n")}\n`;
    return {
      url: "omp://docs",
      label: "omp://docs",
      content,
      contentType: "text/markdown",
      size: Buffer.byteLength(content, "utf8"),
      immutable: true,
      kind: "omp",
    };
  }

  rel = rel.replace(/^docs\//, "");
  splitSafeRelativePath(rel, { allowEmpty: false });
  const doc = OMP_DOCS[rel];
  if (!doc) {
    throw new Error(`OMP doc not bundled: omp://${rel}. Try omp://docs.`);
  }

  return {
    url: `omp://${rel}`,
    label: `omp://${rel}`,
    content: doc,
    contentType: "text/markdown",
    size: Buffer.byteLength(doc, "utf8"),
    immutable: true,
    kind: "omp",
  };
}

async function renderLocalTree(uri: vscode.Uri, prefix: string, depth: number, maxDepth: number, maxEntries: number): Promise<string[]> {
  if (maxEntries <= 0) return ["...[truncated]"];

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }

  const lines: string[] = [];
  for (const [name, type] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (lines.length >= maxEntries) {
      lines.push("...[truncated]");
      break;
    }

    const isDirectory = type === vscode.FileType.Directory;
    const childPath = `${prefix}${name}${isDirectory ? "/" : ""}`;
    lines.push(`${isDirectory ? "dir " : "file"}  ${childPath}`);
    if (isDirectory && depth + 1 < maxDepth) {
      const childLines = await renderLocalTree(vscode.Uri.joinPath(uri, name), childPath, depth + 1, maxDepth, maxEntries - lines.length);
      lines.push(...childLines);
    }
  }
  return lines;
}

function localUriForPath(input: string, ctx: AlphaContext, opts: { allowEmpty: boolean }): vscode.Uri {
  const parts = splitSafeRelativePath(input, opts);
  return parts.length ? vscode.Uri.joinPath(localRoot(ctx), ...parts) : localRoot(ctx);
}

function localRoot(ctx: AlphaContext): vscode.Uri {
  const root = ctx.extensionContext.storageUri ?? ctx.extensionContext.globalStorageUri;
  return vscode.Uri.joinPath(root, "alpha-local", sanitizePathSegment(ctx.sessionKey));
}

function parseInternalUrl(input: string): ParsedInternalUrl {
  const parsed = tryParseInternalUrl(input);
  if (!parsed) throw new Error(`Unsupported internal URL: ${input}`);
  return parsed;
}

function tryParseInternalUrl(input: string): ParsedInternalUrl | undefined {
  const match = input.trim().match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([\s\S]*)$/);
  if (!match) return undefined;
  const scheme = match[1].toLowerCase();
  if (!INTERNAL_SCHEMES.has(scheme)) return undefined;

  const rest = match[2] ?? "";
  const queryStart = rest.indexOf("?");
  const hashStart = rest.indexOf("#");
  const end = [queryStart, hashStart].filter((value) => value >= 0).sort((a, b) => a - b)[0] ?? rest.length;
  const rawPath = rest.slice(0, end);
  const rawQuery = queryStart >= 0 ? rest.slice(queryStart + 1, hashStart >= 0 && hashStart > queryStart ? hashStart : undefined) : "";
  return {
    scheme: scheme as ParsedInternalUrl["scheme"],
    path: decodePath(rawPath),
    query: new URLSearchParams(rawQuery),
  };
}

function normalizeInternalUrl(parsed: ParsedInternalUrl): string {
  return `${parsed.scheme}://${stripSlashes(parsed.path)}`;
}

function stripSlashes(input: string): string {
  return input.replace(/^\/+/, "").replace(/\/+$/, "");
}

function splitSafeRelativePath(input: string, opts: { allowEmpty: boolean }): string[] {
  const normalized = stripSlashes(input).replace(/\\/g, "/");
  if (!normalized) {
    if (opts.allowEmpty) return [];
    throw new Error("Expected a non-empty internal URL path.");
  }

  if (path.posix.isAbsolute(normalized)) throw new Error(`Absolute internal URL paths are not allowed: ${input}`);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Path traversal is not allowed in internal URL: ${input}`);
  }
  return parts;
}

function decodePath(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    throw new Error(`Invalid percent-encoding in internal URL path: ${input}`);
  }
}

function sanitizePathSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "default";
}

function contentTypeForPath(filePath: string): InternalResource["contentType"] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".mdx") return "text/markdown";
  if (ext === ".json") return "application/json";
  return "text/plain";
}

function skillRoots(): string[] {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return [
    path.join(cwd, ".alpha", "skills"),
    path.join(cwd, ".omp", "skills"),
    path.join(cwd, ".codex", "skills"),
    path.join(cwd, ".claude", "skills"),
    path.join(os.homedir(), ".alpha", "skills"),
    path.join(os.homedir(), ".omp", "skills"),
    path.join(os.homedir(), ".codex", "skills"),
  ];
}

function ruleRoots(): string[] {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return [
    path.join(cwd, ".alpha", "rules"),
    path.join(cwd, ".omp", "rules"),
    path.join(cwd, ".codex", "rules"),
    cwd,
    path.join(os.homedir(), ".alpha", "rules"),
    path.join(os.homedir(), ".omp", "rules"),
    path.join(os.homedir(), ".codex", "rules"),
  ];
}

async function listNamedFiles(roots: string[]): Promise<Array<{ name: string; detail?: string }>> {
  const out: Array<{ name: string; detail?: string }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(root, entry);
      let fileStat;
      try {
        fileStat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      const name = fileStat.isDirectory() ? entry : stripKnownExtension(entry);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, detail: root });
    }
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

async function findNamedFile(kind: "skill" | "rule", input: string, roots: string[]): Promise<{ path: string } | undefined> {
  const parts = splitSafeRelativePath(input, { allowEmpty: false });
  const [name, ...rest] = parts;
  for (const root of roots) {
    const candidates = kind === "skill"
      ? skillCandidates(root, name, rest)
      : ruleCandidates(root, name, rest);
    for (const candidate of candidates) {
      try {
        const fileStat = await fs.stat(candidate);
        if (fileStat.isFile()) return { path: candidate };
      } catch {
        // Try the next candidate.
      }
    }
  }
  return undefined;
}

function skillCandidates(root: string, name: string, rest: string[]): string[] {
  if (rest.length) return [path.join(root, name, ...rest)];
  return [
    path.join(root, name, "SKILL.md"),
    path.join(root, name, "skill.md"),
    path.join(root, `${name}.md`),
  ];
}

function ruleCandidates(root: string, name: string, rest: string[]): string[] {
  if (rest.length) return [path.join(root, name, ...rest)];
  const candidates = [
    path.join(root, `${name}.md`),
    path.join(root, name),
    path.join(root, name, "RULE.md"),
    path.join(root, name, "rule.md"),
  ];
  const upper = name.toUpperCase();
  if (upper === "AGENTS") candidates.push(path.join(root, "AGENTS.md"));
  if (upper === "CLAUDE") candidates.push(path.join(root, "CLAUDE.md"));
  if (upper === "GEMINI") candidates.push(path.join(root, "GEMINI.md"));
  if (name === ".cursorrules" || name === "cursorrules") candidates.push(path.join(root, ".cursorrules"));
  return candidates;
}

function stripKnownExtension(name: string): string {
  return name.replace(/\.(?:md|mdx|txt|json)$/i, "");
}
