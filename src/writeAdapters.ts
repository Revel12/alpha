import { gzipSync } from "node:zlib";
import { openArchive, splitArchiveTarget, splitSqliteTarget } from "./readAdapters";
import { assertSqliteIdentifier, quoteSqliteIdentifier, runSqliteChange, runSqliteExec, runSqliteTsv, sqlLiteral } from "./sqlitePortable";

export interface ArchiveWriteTarget {
  archivePath: string;
  memberPath: string;
}

export interface SqliteWriteTarget {
  dbPath: string;
  table: string;
  key?: string;
}

export function parseArchiveWriteTarget(input: string): ArchiveWriteTarget | undefined {
  const target = splitArchiveTarget(input);
  if (!target) return undefined;
  const memberPath = normalizeArchiveSubPath(target.memberPath);
  return { archivePath: target.archivePath, memberPath };
}

export function parseSqliteWriteTarget(input: string): SqliteWriteTarget | undefined {
  const target = splitSqliteTarget(input);
  if (!target) return undefined;
  if (target.selector.startsWith("?")) throw new Error("SQLite write paths do not support query parameters.");
  const normalized = target.selector.replace(/^:+/, "").trim();
  if (!normalized) throw new Error("SQLite write path must target a table.");
  const separatorIndex = normalized.indexOf(":");
  const table = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const key = separatorIndex === -1 ? undefined : normalized.slice(separatorIndex + 1);
  assertSqliteIdentifier(table);
  if (key !== undefined && key.length === 0) throw new Error("SQLite row writes require a non-empty row key.");
  return { dbPath: target.dbPath, table, key };
}

export async function writeArchiveEntry(archivePath: string, existingBytes: Uint8Array | undefined, memberPath: string, content: string): Promise<Buffer> {
  const lower = archivePath.toLowerCase();
  const entries = new Map<string, Buffer>();

  if (existingBytes && existingBytes.byteLength > 0) {
    for (const entry of openArchive(archivePath, Buffer.from(existingBytes))) {
      if (!entry.directory && entry.read) entries.set(entry.path.replace(/\\/g, "/"), entry.read());
    }
  }
  entries.set(normalizeArchiveSubPath(memberPath), Buffer.from(content, "utf8"));

  if (lower.endsWith(".zip")) return buildZip(entries);
  if (lower.endsWith(".tar")) return buildTar(entries);
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return gzipSync(buildTar(entries));
  throw new Error(`Unsupported archive write format: ${archivePath}`);
}

export async function writeSqliteRow(dbPath: string, target: SqliteWriteTarget, content: string): Promise<string> {
  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    if (!target.key) throw new Error("SQLite deletes require a row key in the path.");
    const lookup = await sqliteLookupColumn(dbPath, target.table);
    const deleted = await runSqliteChange(
      dbPath,
      `DELETE FROM ${quoteSqliteIdentifier(target.table)} WHERE ${quoteSqliteIdentifier(lookup)} = ${sqlLiteral(target.key)}`,
    );
    return deleted === 0 ? `No row deleted from ${target.table} for key '${target.key}'` : `Deleted row '${target.key}' from ${target.table}`;
  }

  const parsed = parseJsonObject(trimmedContent);
  const keys = Object.keys(parsed);
  if (keys.length === 0) throw new Error("SQLite write content must contain at least one JSON property.");
  for (const key of keys) assertSqliteIdentifier(key);

  if (target.key) {
    const lookup = await sqliteLookupColumn(dbPath, target.table);
    const assignments = keys.map((key) => `${quoteSqliteIdentifier(key)} = ${sqlLiteral(parsed[key])}`).join(", ");
    const updated = await runSqliteChange(
      dbPath,
      `UPDATE ${quoteSqliteIdentifier(target.table)} SET ${assignments} WHERE ${quoteSqliteIdentifier(lookup)} = ${sqlLiteral(target.key)}`,
    );
    return updated === 0 ? `No row updated in ${target.table} for key '${target.key}'` : `Updated row '${target.key}' in ${target.table}`;
  }

  const columns = keys.map(quoteSqliteIdentifier).join(", ");
  const values = keys.map((key) => sqlLiteral(parsed[key])).join(", ");
  await runSqliteExec(dbPath, `INSERT INTO ${quoteSqliteIdentifier(target.table)} (${columns}) VALUES (${values})`);
  return `Inserted row into ${target.table}`;
}

export function normalizeArchiveSubPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/");
  if (!normalized || normalized.endsWith("/")) throw new Error("Archive write path must target a file inside the archive.");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("Archive path cannot contain '..'.");
    parts.push(part);
  }
  if (parts.length === 0) throw new Error("Archive write path must target a file inside the archive.");
  return parts.join("/");
}

function buildZip(entries: Map<string, Buffer>): Buffer {
  const fileRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of [...entries.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(dosTimeDate(), 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.byteLength, 18);
    local.writeUInt32LE(content.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);
    fileRecords.push(local, nameBytes, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(dosTimeDate(), 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.byteLength, 20);
    central.writeUInt32LE(content.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, nameBytes);

    offset += local.byteLength + nameBytes.byteLength + content.byteLength;
  }

  const centralOffset = offset;
  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(centralDirectory.byteLength, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...fileRecords, centralDirectory, eocd]);
}

function buildTar(entries: Map<string, Buffer>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of [...entries.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const header = Buffer.alloc(512);
    header.write(name, 0, Math.min(Buffer.byteLength(name), 100), "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(content.byteLength.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, "ascii");
    header.fill(" ", 148, 156);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    chunks.push(header, content, Buffer.alloc(Math.ceil(content.byteLength / 512) * 512 - content.byteLength));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function dosTimeDate(): number {
  const date = new Date();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return (dosDate << 16) | dosTime;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function sqliteLookupColumn(dbPath: string, table: string): Promise<string> {
  const info = await runSqliteTsv(dbPath, `PRAGMA table_info(${quoteSqliteIdentifier(table)});`);
  const lines = info.trim().split(/\r?\n/).filter(Boolean);
  const dataLines = lines[0]?.startsWith("cid\t") ? lines.slice(1) : lines;
  for (const line of dataLines) {
    const parts = line.split("|");
    const normalizedParts = parts.length === 1 ? line.split("\t") : parts;
    if (normalizedParts[5] && normalizedParts[5] !== "0") return normalizedParts[1] ?? "rowid";
  }
  return "rowid";
}

function parseJsonObject(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SQLite write content must be a JSON object.");
  return parsed as Record<string, unknown>;
}
