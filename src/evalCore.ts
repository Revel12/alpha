import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vm from "node:vm";

export type EvalLanguage = "py" | "js";
export type EvalCellStatus = "pending" | "running" | "complete" | "error";

export interface EvalCellInput {
  language: EvalLanguage;
  code: string;
  title?: string;
  timeout?: number;
  reset?: boolean;
}

export interface EvalParams {
  cells: EvalCellInput[];
}

export interface EvalDisplayOutput {
  type: "json" | "markdown" | "status";
  data?: unknown;
  text?: string;
}

export interface EvalCellResult {
  index: number;
  title?: string;
  code: string;
  language: EvalLanguage;
  output: string;
  status: EvalCellStatus;
  durationMs: number;
  exitCode?: number;
  displayOutputs: EvalDisplayOutput[];
}

export interface EvalRunResult {
  cells: EvalCellResult[];
  output: string;
  isError: boolean;
  languages: EvalLanguage[];
  notice?: string;
}

export interface EvalRuntimeCallbacks {
  cwd: string;
  sessionKey: string;
  signal?: AbortSignal;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<string>;
  append(path: string, content: string): Promise<string>;
  tree(path: string, maxDepth?: number, showHidden?: boolean): Promise<string>;
  tool(name: string, args: object): Promise<unknown>;
  env(key?: string, value?: string): Record<string, string> | string | undefined;
  pythonCommand?: string;
}

interface JsKernel {
  context: vm.Context;
}

const jsKernels = new Map<string, JsKernel>();

export function parseEvalInput(args: string): EvalParams {
  const trimmed = args.trim();
  if (!trimmed) throw new Error("eval requires JSON input with cells.");
  const parsed = JSON.parse(trimmed) as unknown;
  return validateEvalParams(parsed);
}

export function validateEvalParams(raw: unknown): EvalParams {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { cells?: unknown }).cells)) {
    throw new Error("eval expects JSON object with cells array.");
  }
  const cells = (raw as { cells: unknown[] }).cells.map(validateEvalCell);
  if (cells.length === 0) throw new Error("eval cells must contain at least one cell.");
  return { cells };
}

export async function runEvalCells(params: EvalParams, callbacks: EvalRuntimeCallbacks): Promise<EvalRunResult> {
  const results: EvalCellResult[] = [];
  const chunks: string[] = [];
  const languages: EvalLanguage[] = [];
  let isError = false;

  for (let index = 0; index < params.cells.length; index++) {
    const cell = params.cells[index];
    if (!languages.includes(cell.language)) languages.push(cell.language);
    const result = await runEvalCell(cell, index, callbacks);
    results.push(result);
    if (result.output.trim()) chunks.push(formatCellOutput(result));
    for (const display of result.displayOutputs) {
      if (display.type === "json") chunks.push(formatDisplayJson(display.data));
      if (display.type === "markdown" && display.text) chunks.push(display.text);
    }
    if (result.status === "error" || (result.exitCode !== undefined && result.exitCode !== 0)) {
      isError = true;
      break;
    }
  }

  return {
    cells: results,
    output: chunks.join("\n\n").trim() || "(no output)",
    isError,
    languages,
    notice: languages.includes("py")
      ? "Alpha Python eval uses a subprocess backend, so Python variables do not persist like OMP's IPython kernel yet. JS VM state persists per Alpha session where Node VM supports it."
      : "Alpha JS eval state persists per Alpha session where Node VM supports it.",
  };
}

export function resetEvalSession(sessionKey: string, language?: EvalLanguage): void {
  if (!language || language === "js") jsKernels.delete(sessionKey);
}

export function formatEvalResult(result: EvalRunResult, artifactUrl?: string): string {
  const lines: string[] = [];
  if (result.notice) lines.push(`Notice: ${result.notice}`, "");
  lines.push(result.output);
  if (artifactUrl) lines.push("", `Raw output: ${artifactUrl}`);
  return lines.join("\n").trim();
}

async function runEvalCell(cell: EvalCellInput, index: number, callbacks: EvalRuntimeCallbacks): Promise<EvalCellResult> {
  const started = Date.now();
  const result: EvalCellResult = {
    index,
    title: cell.title,
    code: cell.code,
    language: cell.language,
    output: "",
    status: "running",
    durationMs: 0,
    displayOutputs: [],
  };

  try {
    const timeoutSeconds = clampTimeout(cell.timeout);
    if (cell.reset) resetEvalSession(callbacks.sessionKey, cell.language);
    const execution = cell.language === "js"
      ? runJsCell(cell.code, timeoutSeconds, callbacks, result.displayOutputs)
      : runPythonCell(cell.code, timeoutSeconds, callbacks);
    const output = await withTimeout(execution, timeoutSeconds * 1000, callbacks.signal);
    result.output = output.output;
    result.exitCode = output.exitCode;
    result.status = output.exitCode === 0 ? "complete" : "error";
  } catch (error) {
    result.output = error instanceof Error ? error.stack ?? error.message : String(error);
    result.exitCode = callbacks.signal?.aborted ? 130 : 1;
    result.status = "error";
  } finally {
    result.durationMs = Date.now() - started;
  }

  return result;
}

async function runJsCell(
  code: string,
  timeoutSeconds: number,
  callbacks: EvalRuntimeCallbacks,
  displays: EvalDisplayOutput[],
): Promise<{ output: string; exitCode: number }> {
  const kernel = getJsKernel(callbacks.sessionKey, callbacks);
  const lines: string[] = [];
  installJsHelpers(kernel.context, callbacks, lines, displays);
  const cleaned = stripCodeFence(code);
  try {
    let value: unknown;
    try {
      value = vm.runInContext(cleaned, kernel.context, { timeout: timeoutSeconds * 1000 });
    } catch (error) {
      if (!isAwaitSyntaxError(error) || !/\bawait\b/.test(cleaned)) throw error;
      value = vm.runInContext(`(async () => {\n${cleaned}\n})()`, kernel.context, { timeout: timeoutSeconds * 1000 });
    }
    const resolved = await value;
    if (resolved !== undefined) lines.push(formatValue(resolved));
    return { output: lines.join("\n"), exitCode: 0 };
  } catch (error) {
    lines.push(error instanceof Error ? error.stack ?? error.message : String(error));
    return { output: lines.join("\n"), exitCode: 1 };
  }
}

function isAwaitSyntaxError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { name?: unknown; message?: unknown };
  return maybe.name === "SyntaxError" && typeof maybe.message === "string" && maybe.message.includes("await");
}

async function runPythonCell(
  code: string,
  timeoutSeconds: number,
  callbacks: EvalRuntimeCallbacks,
): Promise<{ output: string; exitCode: number }> {
  const command = callbacks.pythonCommand ?? "python3";
  const prelude = [
    "import json, os, pathlib, sys",
    "def display(value):",
    "    print(json.dumps(value, indent=2, default=str) if not isinstance(value, str) else value)",
    "def read(path, offset=1, limit=None):",
    "    p = pathlib.Path(path)",
    "    text = p.read_text()",
    "    lines = text.splitlines()",
    "    if limit is None: return text",
    "    return '\\n'.join(lines[max(0, offset-1):max(0, offset-1)+limit])",
    "def write(path, content):",
    "    p = pathlib.Path(path); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(content); return str(p)",
    "def append(path, content):",
    "    p = pathlib.Path(path); p.parent.mkdir(parents=True, exist_ok=True); open(p, 'a').write(content); return str(p)",
    "",
  ].join("\n");
  const source = `${prelude}\n${stripCodeFence(code)}\n`;
  return runProcess(command, ["-c", source], callbacks.cwd, timeoutSeconds * 1000, callbacks.signal);
}

function getJsKernel(sessionKey: string, callbacks: EvalRuntimeCallbacks): JsKernel {
  const existing = jsKernels.get(sessionKey);
  if (existing) return existing;
  const sandbox = {
    Buffer,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    globalThis: undefined as unknown,
  };
  const context = vm.createContext(sandbox);
  (context as { globalThis: unknown }).globalThis = context;
  const kernel = { context };
  jsKernels.set(sessionKey, kernel);
  return kernel;
}

function installJsHelpers(
  context: vm.Context,
  callbacks: EvalRuntimeCallbacks,
  lines: string[],
  displays: EvalDisplayOutput[],
): void {
  Object.assign(context, {
    console: {
      log: (...values: unknown[]) => lines.push(values.map(formatValue).join(" ")),
      error: (...values: unknown[]) => lines.push(values.map(formatValue).join(" ")),
      warn: (...values: unknown[]) => lines.push(values.map(formatValue).join(" ")),
    },
    print: (...values: unknown[]) => lines.push(values.map(formatValue).join(" ")),
    display: (value: unknown) => {
      displays.push({ type: "json", data: value });
      lines.push(formatDisplayJson(value));
    },
    read: (target: string) => callbacks.read(target),
    write: (target: string, content: string) => callbacks.write(target, content),
    append: (target: string, content: string) => callbacks.append(target, content),
    tree: (target = ".", maxDepth = 3, showHidden = false) => callbacks.tree(target, maxDepth, showHidden),
    env: (key?: string, value?: string) => callbacks.env(key, value),
    tool: new Proxy({}, {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        return (args: object = {}) => callbacks.tool(property, args);
      },
    }),
    completion: () => {
      throw new Error("completion() is not available in Alpha eval yet; use the main chat or task tool.");
    },
    agent: () => {
      throw new Error("agent() is not available in Alpha eval yet; use the task tool.");
    },
    parallel: async (thunks: Array<() => unknown>) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async (items: unknown[], ...stages: Array<(value: unknown) => unknown>) => {
      let current = items;
      for (const stage of stages) current = await Promise.all(current.map((item) => stage(item)));
      return current;
    },
    log: (message: unknown) => lines.push(String(message)),
    phase: (title: unknown) => lines.push(`## ${String(title)}`),
    budget: {
      total: async () => null,
      spent: async () => 0,
      remaining: async () => Infinity,
      hard: async () => false,
    },
  });
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ output: error.message, exitCode: 1 });
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const exitCode = sig ? 130 : code ?? 1;
      resolve({ output: Buffer.concat(chunks).toString("utf8"), exitCode });
    });
  });
}

function validateEvalCell(raw: unknown): EvalCellInput {
  if (!raw || typeof raw !== "object") throw new Error("eval cell must be an object.");
  const input = raw as Record<string, unknown>;
  if (input.language !== "py" && input.language !== "js") throw new Error('eval cell language must be "py" or "js".');
  if (typeof input.code !== "string") throw new Error("eval cell code must be a string.");
  const timeout = input.timeout === undefined ? undefined : Number(input.timeout);
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)) {
    throw new Error("eval cell timeout must be an integer from 1 to 3600 seconds.");
  }
  return {
    language: input.language,
    code: input.code,
    title: typeof input.title === "string" ? input.title : undefined,
    timeout,
    reset: input.reset === true,
  };
}

function clampTimeout(timeout: number | undefined): number {
  if (timeout === undefined) return 30;
  return Math.max(1, Math.min(3600, timeout));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error("eval cancelled.");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`eval timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
        signal?.addEventListener("abort", () => reject(new Error("eval cancelled.")), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stripCodeFence(code: string): string {
  const trimmed = code.trim();
  const match = /^```(?:js|javascript|py|python)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match ? match[1] : code;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatDisplayJson(value: unknown): string {
  const text = formatValue(value);
  return text.length > 8000 ? `display:\n${text.slice(0, 8000)}\n... (${text.length - 8000} chars truncated)` : `display:\n${text}`;
}

function formatCellOutput(result: EvalCellResult): string {
  const title = result.title ? ` (${result.title})` : "";
  return `Cell ${result.index + 1}${title} [${result.language}] ${result.status}:\n${result.output.trimEnd()}`;
}

export async function readFileText(target: string, cwd: string): Promise<string> {
  const filePath = path.resolve(cwd, target);
  return fs.readFile(filePath, "utf8");
}
