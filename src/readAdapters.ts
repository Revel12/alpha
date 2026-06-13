import * as path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { quoteSqliteIdentifier, runSqliteTable, sqlLiteral } from "./sqlitePortable";

const textDecoder = new TextDecoder("utf-8", { fatal: false });

export interface ReadAdapterResult {
  label: string;
  content: string;
  immutable?: boolean;
}

export interface ArchiveTarget {
  archivePath: string;
  memberPath: string;
}

export interface SqliteTarget {
  dbPath: string;
  selector: string;
}

export interface ArchiveEntry {
  path: string;
  directory: boolean;
  size: number;
  read?: () => Buffer;
}

export function isWebUrlPath(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

export async function readWebUrl(input: string, raw: boolean): Promise<ReadAdapterResult> {
  const response = await fetch(input);
  if (!response.ok) {
    throw new Error(`URL read failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  let content = text;

  if (!raw) {
    if (contentType.includes("application/json") || looksLikeJson(text)) {
      try {
        content = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        content = text;
      }
    } else if (contentType.includes("html") || /<html[\s>]/i.test(text)) {
      content = htmlToText(text);
    }
  }

  return {
    label: `${input}${contentType ? ` (${contentType.split(";")[0]})` : ""}`,
    content,
    immutable: true,
  };
}

export function splitArchiveTarget(input: string): ArchiveTarget | undefined {
  const match = input.match(/\.(zip|tar|tgz|tar\.gz)(?::|$)/i);
  if (!match || match.index === undefined) return undefined;
  const archiveEnd = match.index + match[0].replace(/:$/, "").length;
  const archivePath = input.slice(0, archiveEnd);
  const memberPath = input.slice(archiveEnd).replace(/^:/, "").replace(/^\/+/, "");
  return { archivePath, memberPath };
}

export async function readArchiveTarget(archivePath: string, archiveBytes: Uint8Array, memberPath: string): Promise<ReadAdapterResult> {
  const entries = openArchive(archivePath, Buffer.from(archiveBytes));
  const normalizedMemberPath = normalizeMemberPath(memberPath);
  const label = normalizedMemberPath ? `${archivePath}:${normalizedMemberPath}` : archivePath;

  if (!normalizedMemberPath) {
    return { label, content: formatArchiveListing(entries, ""), immutable: true };
  }

  const direct = entries.find((entry) => normalizeMemberPath(entry.path) === normalizedMemberPath);
  if (direct?.directory) return { label, content: formatArchiveListing(entries, normalizedMemberPath), immutable: true };
  if (direct?.read) {
    const bytes = direct.read();
    if (looksBinary(bytes)) {
      return { label, content: `[Binary archive member: ${direct.path}, ${bytes.byteLength} bytes]`, immutable: true };
    }
    return { label, content: textDecoder.decode(bytes), immutable: true };
  }

  const prefix = normalizedMemberPath.endsWith("/") ? normalizedMemberPath : `${normalizedMemberPath}/`;
  if (entries.some((entry) => normalizeMemberPath(entry.path).startsWith(prefix))) {
    return { label, content: formatArchiveListing(entries, normalizedMemberPath), immutable: true };
  }

  throw new Error(`Archive member not found: ${archivePath}:${normalizedMemberPath}`);
}

export function splitSqliteTarget(input: string): SqliteTarget | undefined {
  const match = input.match(/\.(sqlite3?|db3?|sqlite)(?::|\?|$)/i);
  if (!match || match.index === undefined) return undefined;
  const dbEnd = match.index + match[0].replace(/[:?].*$/, "").length;
  return {
    dbPath: input.slice(0, dbEnd),
    selector: input.slice(dbEnd).replace(/^:/, ""),
  };
}

export async function readSqliteTarget(dbPath: string, selector: string): Promise<ReadAdapterResult> {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) {
    const tableList = await sqlite(dbPath, [
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name;",
    ].join(""));
    return { label: dbPath, content: tableList.trim() || "(no tables or views)", immutable: true };
  }

  const querySelector = normalizedSelector.startsWith("?") ? normalizedSelector.slice(1) : "";
  if (querySelector) {
    const params = new URLSearchParams(querySelector);
    const query = params.get("q") ?? "";
    if (!/^\s*(select|with|pragma)\b/i.test(query)) {
      throw new Error("SQLite read only accepts SELECT, WITH, or PRAGMA queries.");
    }
    return {
      label: `${dbPath}?${querySelector}`,
      content: await sqlite(dbPath, query),
      immutable: true,
    };
  }

  const [tableName, rowKey] = normalizedSelector.split(":");
  const table = quoteSqliteIdentifier(tableName);
  if (!rowKey) {
    const schema = await sqlite(dbPath, `SELECT sql FROM sqlite_master WHERE name = ${sqlLiteral(tableName)} ORDER BY type LIMIT 1;`);
    const rows = await sqlite(dbPath, `SELECT * FROM ${table} LIMIT 25;`);
    return {
      label: `${dbPath}:${tableName}`,
      content: [`# Schema`, schema.trim() || "(no schema)", "", "# Rows", rows.trim() || "(no rows)"].join("\n"),
      immutable: true,
    };
  }

  const key = rowKey.replace(/'/g, "''");
  const rows = await sqlite(dbPath, `SELECT * FROM ${table} WHERE rowid = ${sqlLiteral(key)} LIMIT 1;`);
  return { label: `${dbPath}:${tableName}:${rowKey}`, content: rows.trim() || "(no row)", immutable: true };
}

export function readSpecialFile(displayPath: string, bytes: Uint8Array, raw: boolean): ReadAdapterResult | undefined {
  const lower = displayPath.toLowerCase();
  if (!raw && lower.endsWith(".ipynb")) {
    return { label: displayPath, content: notebookToText(bytes), immutable: true };
  }

  const image = readImageMetadata(displayPath, Buffer.from(bytes));
  if (!raw && image) {
    return { label: displayPath, content: formatImageMetadata(image), immutable: true };
  }

  if (!raw && isConvertibleDocument(displayPath)) {
    return { label: displayPath, content: convertDocument(displayPath, Buffer.from(bytes)), immutable: true };
  }

  return undefined;
}

export function structuralSummary(displayPath: string, content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  if (lines.length < 80) return undefined;

  const ext = path.extname(displayPath).toLowerCase();
  const kept = new Set<number>();

  const basename = path.basename(displayPath).toLowerCase();

  if ([".md", ".markdown", ".txt"].includes(ext)) {
    collectMarkdownSummary(lines, kept);
  } else if ([".json", ".jsonc"].includes(ext)) {
    collectJsonSummary(content, lines, kept);
  } else if ([".yml", ".yaml"].includes(ext)) {
    collectYamlSummary(lines, kept);
  } else if ([".tf", ".tfvars", ".hcl"].includes(ext)) {
    collectHclSummary(lines, kept);
  } else if (ext === ".tpl" || basename === "dockerfile" || basename.endsWith(".dockerfile")) {
    if (ext === ".tpl") collectHelmTemplateSummary(lines, kept);
    else collectDockerfileSummary(lines, kept);
  } else {
    collectCodeSummary(lines, kept);
  }

  if (kept.size < 4) return undefined;
  const sorted = [...kept].sort((a, b) => a - b);
  const rendered: string[] = [];
  let previous = 0;
  const ranges: string[] = [];

  for (const line of sorted) {
    if (previous && line > previous + 1) {
      rendered.push("...");
      ranges.push(`${previous + 1}-${line - 1}`);
    }
    rendered.push(`${line}:${lines[line - 1] ?? ""}`);
    previous = line;
  }

  if (previous < lines.length) ranges.push(`${previous + 1}-${lines.length}`);
  rendered.push(`[structural summary; re-read omitted ranges as needed, e.g. ${displayPath}:${ranges.slice(0, 3).join(",")}]`);
  return rendered.join("\n");
}

export function notebookToText(bytes: Uint8Array): string {
  const notebook = JSON.parse(textDecoder.decode(bytes)) as { cells?: Array<{ cell_type?: string; source?: string | string[]; outputs?: unknown[] }> };
  const cells = notebook.cells ?? [];
  const parts: string[] = [];

  cells.forEach((cell, index) => {
    const kind = cell.cell_type === "markdown" ? "markdown" : "code";
    parts.push(`# %% [${kind}] cell:${index + 1}`);
    parts.push(sourceToText(cell.source));
    if (Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      parts.push(`# outputs: ${cell.outputs.length}`);
    }
  });

  return parts.join("\n").trimEnd();
}

export function readImageMetadata(filePath: string, bytes: Buffer): { format: string; mime: string; width?: number; height?: number; bytes: number; alpha?: boolean; channels?: number } | undefined {
  const lower = filePath.toLowerCase();
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const colorType = bytes[25];
    return {
      format: "PNG",
      mime: "image/png",
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      bytes: bytes.byteLength,
      alpha: colorType === 4 || colorType === 6,
      channels: colorType === 6 ? 4 : colorType === 2 ? 3 : undefined,
    };
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const jpeg = readJpegSize(bytes);
    return { format: "JPEG", mime: "image/jpeg", width: jpeg?.width, height: jpeg?.height, bytes: bytes.byteLength, channels: jpeg?.channels };
  }

  if (bytes.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) {
    return { format: "GIF", mime: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), bytes: bytes.byteLength };
  }

  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    const webp = readWebpSize(bytes);
    return { format: "WebP", mime: "image/webp", width: webp?.width, height: webp?.height, bytes: bytes.byteLength, alpha: webp?.alpha };
  }

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].some((ext) => lower.endsWith(ext))) {
    return { format: path.extname(filePath).slice(1).toUpperCase(), mime: "image/*", bytes: bytes.byteLength };
  }
  return undefined;
}

export function openArchive(archivePath: string, bytes: Buffer): ArchiveEntry[] {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip") || lower.endsWith(".docx") || lower.endsWith(".pptx") || lower.endsWith(".xlsx") || lower.endsWith(".epub")) {
    return openZip(bytes);
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return openTar(gunzipSync(bytes));
  if (lower.endsWith(".tar")) return openTar(bytes);
  throw new Error(`Unsupported archive format: ${archivePath}`);
}

function openZip(bytes: Buffer): ArchiveEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) throw new Error("Invalid ZIP: missing central directory.");
  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  let offset = bytes.readUInt32LE(eocdOffset + 16);
  const entries: ArchiveEntry[] = [];

  for (let index = 0; index < totalEntries; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const directory = name.endsWith("/");

    entries.push({
      path: name,
      directory,
      size: uncompressedSize,
      read: directory
        ? undefined
        : () => {
            const localNameLength = bytes.readUInt16LE(localOffset + 26);
            const localExtraLength = bytes.readUInt16LE(localOffset + 28);
            const start = localOffset + 30 + localNameLength + localExtraLength;
            const compressed = bytes.subarray(start, start + compressedSize);
            if (method === 0) return Buffer.from(compressed);
            if (method === 8) return Buffer.from(inflateRawSync(compressed));
            throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
          },
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function openTar(bytes: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const name = cString(block.subarray(0, 100));
    const prefix = cString(block.subarray(345, 500));
    const fullName = [prefix, name].filter(Boolean).join("/");
    const size = Number.parseInt(cString(block.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(block[156] || 0);
    const contentStart = offset + 512;
    const directory = type === "5" || fullName.endsWith("/");

    entries.push({
      path: fullName,
      directory,
      size,
      read: directory ? undefined : () => Buffer.from(bytes.subarray(contentStart, contentStart + size)),
    });

    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function formatArchiveListing(entries: ArchiveEntry[], memberPath: string): string {
  const prefix = memberPath ? `${normalizeMemberPath(memberPath).replace(/\/$/, "")}/` : "";
  const rows = new Map<string, ArchiveEntry | "dir">();
  for (const entry of entries) {
    const normalized = normalizeMemberPath(entry.path);
    if (!normalized.startsWith(prefix) || normalized === prefix) continue;
    const rest = normalized.slice(prefix.length);
    const [head] = rest.split("/");
    if (!head) continue;
    rows.set(rest.includes("/") ? `${head}/` : head, rest.includes("/") ? "dir" : entry);
  }

  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => (entry === "dir" ? `dir  ${name}` : `file ${name} (${formatBytes(entry.size)})`))
    .join("\n") || "(empty archive directory)";
}

function convertDocument(displayPath: string, bytes: Buffer): string {
  const lower = displayPath.toLowerCase();
  try {
    if (lower.endsWith(".docx")) return extractZipXmlText(bytes, /^word\/document\.xml$/);
    if (lower.endsWith(".pptx")) return extractZipXmlText(bytes, /^ppt\/slides\/slide\d+\.xml$/);
    if (lower.endsWith(".xlsx")) return extractXlsxText(bytes);
    if (lower.endsWith(".epub")) return extractZipHtmlText(bytes);
    if (lower.endsWith(".rtf")) return rtfToText(textDecoder.decode(bytes));
    if (lower.endsWith(".pdf")) return extractPdfText(bytes);
  } catch (error) {
    return `[Document conversion failed: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return "[Unsupported document conversion in Alpha read.]";
}

function extractZipXmlText(bytes: Buffer, matcher: RegExp): string {
  return openZip(bytes)
    .filter((entry) => matcher.test(entry.path) && entry.read)
    .map((entry) => xmlToText(textDecoder.decode(entry.read?.() ?? Buffer.alloc(0))))
    .filter(Boolean)
    .join("\n\n")
    .trim() || "(no extractable text)";
}

function extractZipHtmlText(bytes: Buffer): string {
  return openZip(bytes)
    .filter((entry) => /\.(xhtml|html?)$/i.test(entry.path) && entry.read)
    .map((entry) => htmlToText(textDecoder.decode(entry.read?.() ?? Buffer.alloc(0))))
    .filter(Boolean)
    .join("\n\n")
    .trim() || "(no extractable text)";
}

function extractXlsxText(bytes: Buffer): string {
  const entries = openZip(bytes);
  const shared = entries.find((entry) => entry.path === "xl/sharedStrings.xml")?.read?.();
  const sharedStrings = shared ? [...textDecoder.decode(shared).matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1] ?? "")) : [];
  const sheets = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.path) && entry.read);
  const output: string[] = [];

  for (const sheet of sheets) {
    output.push(`# ${sheet.path}`);
    const xml = textDecoder.decode(sheet.read?.() ?? Buffer.alloc(0));
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...(row[1] ?? "").matchAll(/<c[^>]*(?:t="([^"]+)")?[^>]*>[\s\S]*?<v>([\s\S]*?)<\/v>[\s\S]*?<\/c>/g)].map((cell) => {
        const type = cell[1] ?? "";
        const value = decodeXml(cell[2] ?? "");
        return type === "s" ? sharedStrings[Number(value)] ?? value : value;
      });
      if (cells.length) output.push(cells.join("\t"));
      if (output.length > 500) break;
    }
  }

  return output.join("\n").trim() || "(no extractable text)";
}

function extractPdfText(bytes: Buffer): string {
  const latin = bytes.toString("latin1");
  const strings = [...latin.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)]
    .map((match) => (match[1] ?? "").replace(/\\([nrtbf()\\])/g, (_all, ch: string) => ({ n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" })[ch] ?? ch))
    .filter((line) => /[A-Za-z0-9]/.test(line));
  return strings.slice(0, 2000).join("\n").trim() || "[PDF detected; no extractable text found by the portable reader.]";
}

function rtfToText(input: string): string {
  return input
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\'[0-9a-fA-F]{2}/g, "")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function xmlToText(input: string): string {
  return decodeXml(input.replace(/<[^>]+>/g, " ")).replace(/[ \t]{2,}/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function htmlToText(input: string): string {
  return decodeXml(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<\/(h[1-6]|p|div|li|tr|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXml(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function sourceToText(source: string | string[] | undefined): string {
  if (Array.isArray(source)) return source.join("");
  return source ?? "";
}

function formatImageMetadata(image: NonNullable<ReturnType<typeof readImageMetadata>>): string {
  const dimensions = image.width && image.height ? `${image.width}x${image.height}` : "unknown dimensions";
  return [
    `format: ${image.format}`,
    `mime: ${image.mime}`,
    `dimensions: ${dimensions}`,
    `bytes: ${image.bytes}`,
    image.channels ? `channels: ${image.channels}` : undefined,
    image.alpha !== undefined ? `alpha: ${image.alpha}` : undefined,
  ].filter(Boolean).join("\n");
}

function readJpegSize(bytes: Buffer): { width: number; height: number; channels: number } | undefined {
  for (let offset = 2; offset + 9 < bytes.length; ) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7), channels: bytes[offset + 9] };
    }
    offset += 2 + length;
  }
  return undefined;
}

function readWebpSize(bytes: Buffer): { width: number; height: number; alpha?: boolean } | undefined {
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && bytes.length >= 30) {
    const flags = bytes[20];
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
      alpha: Boolean(flags & 0x10),
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, alpha: Boolean(bits & 0x10000000) };
  }
  return undefined;
}

function collectMarkdownSummary(lines: string[], kept: Set<number>): void {
  lines.forEach((line, index) => {
    if (/^#{1,6}\s+/.test(line)) keepNearby(kept, index + 1, lines.length, 0, 2);
  });
}

function collectJsonSummary(content: string, lines: string[], kept: Set<number>): void {
  if (content.length > 500_000) return;
  try {
    const parsed = JSON.parse(content) as unknown;
    const keys = summarizeJsonKeys(parsed);
    keys.forEach((key) => {
      const index = lines.findIndex((line) => line.includes(`"${key}"`));
      if (index >= 0) kept.add(index + 1);
    });
  } catch {
    collectCodeSummary(lines, kept);
  }
}

function collectYamlSummary(lines: string[], kept: Set<number>): void {
  lines.forEach((line, index) => {
    if (/^---\s*(?:#.*)?$/.test(line)) {
      keepNearby(kept, index + 1, lines.length, 0, 2);
      return;
    }
    if (/^\s*[A-Za-z0-9_.-]+:\s*(?:#.*)?$/.test(line)) {
      keepNearby(kept, index + 1, lines.length, 0, 1);
      return;
    }
    if (/^\s*(apiVersion|kind|metadata|spec|data|stringData|rules|subjects|containers|template):\s*/.test(line)) {
      keepNearby(kept, index + 1, lines.length, 0, 2);
    }
  });
}

function collectHclSummary(lines: string[], kept: Set<number>): void {
  const block = /^\s*(terraform|provider|resource|data|module|variable|output|locals|backend|dynamic|moved|import|check)\b(?:\s+"[^"]+"){0,2}\s*\{/;
  lines.forEach((line, index) => {
    if (block.test(line)) {
      keepNearby(kept, index + 1, lines.length, 0, 3);
      return;
    }
    if (/^\s*[A-Za-z0-9_-]+\s*=\s*/.test(line) && index < 40) {
      kept.add(index + 1);
    }
  });
}

function collectDockerfileSummary(lines: string[], kept: Set<number>): void {
  const instruction = /^\s*(FROM|ARG|ENV|WORKDIR|USER|COPY|ADD|RUN|CMD|ENTRYPOINT|EXPOSE|VOLUME|HEALTHCHECK|LABEL|SHELL|STOPSIGNAL|ONBUILD)\b/i;
  lines.forEach((line, index) => {
    if (instruction.test(line)) keepNearby(kept, index + 1, lines.length, 0, /^(\s*RUN)\b/i.test(line) ? 2 : 1);
  });
}

function collectHelmTemplateSummary(lines: string[], kept: Set<number>): void {
  lines.forEach((line, index) => {
    if (/^\s*\{\{[- ]?\s*(define|if|range|with|block|template|include)\b/.test(line)) {
      keepNearby(kept, index + 1, lines.length, 0, 2);
      return;
    }
    if (/^\s*(apiVersion|kind|metadata|spec):\s*/.test(line)) {
      keepNearby(kept, index + 1, lines.length, 0, 2);
    }
  });
}

function collectCodeSummary(lines: string[], kept: Set<number>): void {
  const symbol = /^\s*(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|def|class|struct|impl|trait|fn)\s+[A-Za-z_$][\w$]*/;
  lines.forEach((line, index) => {
    if (symbol.test(line) || /^\s*(import|from|package|namespace)\b/.test(line)) keepNearby(kept, index + 1, lines.length, 0, 1);
  });
}

function keepNearby(kept: Set<number>, line: number, max: number, before: number, after: number): void {
  for (let item = Math.max(1, line - before); item <= Math.min(max, line + after); item++) kept.add(item);
}

function summarizeJsonKeys(value: unknown, prefix = "", output: string[] = []): string[] {
  if (!value || typeof value !== "object" || output.length > 80) return output;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    output.push(key);
    summarizeJsonKeys((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key, output);
    if (output.length > 80) break;
  }
  return output;
}

function isConvertibleDocument(displayPath: string): boolean {
  return [".pdf", ".docx", ".pptx", ".xlsx", ".rtf", ".epub"].includes(path.extname(displayPath).toLowerCase());
}

function looksLikeJson(text: string): boolean {
  return /^[\s\r\n]*[{[]/.test(text);
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 1024)).includes(0);
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 0xffff - 22); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function normalizeMemberPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end >= 0 ? end : bytes.length).toString("utf8");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function sqlite(dbPath: string, sql: string): Promise<string> {
  return runSqliteTable(dbPath, sql, true);
}
