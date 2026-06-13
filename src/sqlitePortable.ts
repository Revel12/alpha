import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PYTHON_SQLITE_SCRIPT = String.raw`
import sqlite3
import sys

db_path = sys.argv[1]
sql = sys.argv[2]
readonly = sys.argv[3] == "1"
mode = sys.argv[4]

conn = sqlite3.connect(db_path)
try:
    if readonly:
        conn.execute("PRAGMA query_only = ON")
    cur = conn.cursor()
    cur.execute(sql)
    if mode == "change":
        print(cur.rowcount if cur.rowcount >= 0 else 0)
    elif cur.description is not None:
        headers = [item[0] for item in cur.description]
        print("\t".join(headers))
        for row in cur.fetchall():
            print("\t".join("" if value is None else str(value) for value in row))
    if not readonly:
        conn.commit()
finally:
    conn.close()
`;

export async function runSqliteTable(dbPath: string, sql: string, readonly = true): Promise<string> {
  const tsv = await runSqliteTsv(dbPath, sql, readonly);
  return formatTsvAsTable(tsv);
}

export async function runSqliteTsv(dbPath: string, sql: string, readonly = true): Promise<string> {
  try {
    return await runSqliteCli(["-tabs", "-header", ...(readonly ? ["-readonly"] : []), dbPath, sql]);
  } catch (error) {
    if (!isMissingExecutable(error)) throw normalizeSqliteError("sqlite3", error);
  }

  return runSqlitePython(dbPath, sql, readonly, "query");
}

export async function runSqliteExec(dbPath: string, sql: string): Promise<void> {
  try {
    await runSqliteCli([dbPath, sql]);
    return;
  } catch (error) {
    if (!isMissingExecutable(error)) throw normalizeSqliteError("sqlite3", error);
  }

  await runSqlitePython(dbPath, sql, false, "exec");
}

export async function runSqliteChange(dbPath: string, sql: string): Promise<number> {
  try {
    const output = await runSqliteCli([dbPath, `${sql}; SELECT changes();`]);
    return Number(output.trim().split(/\r?\n/).pop() ?? "0") || 0;
  } catch (error) {
    if (!isMissingExecutable(error)) throw normalizeSqliteError("sqlite3", error);
  }

  const output = await runSqlitePython(dbPath, sql, false, "change");
  return Number(output.trim()) || 0;
}

export function quoteSqliteIdentifier(input: string): string {
  assertSqliteIdentifier(input);
  return `"${input.replace(/"/g, "\"\"")}"`;
}

export function assertSqliteIdentifier(input: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input)) throw new Error(`Invalid SQLite identifier: ${input}`);
}

export function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SQLite JSON numbers must be finite.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

async function runSqliteCli(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("sqlite3", args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  if (stderr.trim()) throw new Error(stderr.trim());
  return stdout;
}

async function runSqlitePython(dbPath: string, sql: string, readonly: boolean, mode: "query" | "exec" | "change"): Promise<string> {
  const candidates: Array<{ command: string; args: string[] }> = [
    { command: "python3", args: ["-c", PYTHON_SQLITE_SCRIPT, dbPath, sql, readonly ? "1" : "0", mode] },
    { command: "python", args: ["-c", PYTHON_SQLITE_SCRIPT, dbPath, sql, readonly ? "1" : "0", mode] },
    { command: "py", args: ["-3", "-c", PYTHON_SQLITE_SCRIPT, dbPath, sql, readonly ? "1" : "0", mode] },
  ];

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate.command, candidate.args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
      if (stderr.trim()) throw new Error(stderr.trim());
      return stdout;
    } catch (error) {
      if (!isMissingExecutable(error)) throw normalizeSqliteError(candidate.command, error);
      failures.push(candidate.command);
    }
  }

  throw new Error(`SQLite support requires either sqlite3 CLI or Python with the standard sqlite3 module. Missing executables: ${failures.join(", ")}`);
}

function formatTsvAsTable(tsv: string): string {
  const rows = tsv.trimEnd().split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
  if (!rows.length) return "";
  const widths = rows[0].map((_cell, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd()).join("\n");
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function normalizeSqliteError(command: string, error: unknown): Error {
  if (error instanceof Error) {
    const record = error as Error & { stderr?: unknown };
    const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
    return new Error(stderr || `${command}: ${error.message}`);
  }
  return new Error(`${command}: ${String(error)}`);
}
