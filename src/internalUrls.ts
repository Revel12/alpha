import * as path from "node:path";
import * as vscode from "vscode";
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
  kind: "artifact" | "history" | "local" | "memory" | "omp" | "pr";
}

interface ParsedInternalUrl {
  scheme: InternalResource["kind"];
  path: string;
}

const INTERNAL_SCHEMES = new Set(["artifact", "history", "local", "memory", "omp", "pr"]);

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
  }
  const exhaustive: never = parsed.scheme;
  throw new Error(`Unsupported internal URL scheme: ${exhaustive}`);
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

  const rawPath = match[2].split(/[?#]/, 1)[0] ?? "";
  return {
    scheme: scheme as ParsedInternalUrl["scheme"],
    path: decodePath(rawPath),
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
