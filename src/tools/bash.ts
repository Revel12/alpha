import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { ensureToolPermission } from "../approval";
import { bashApproval, bashApprovalDetails } from "../approvalCore";
import { registerAsyncBashController, unregisterAsyncBashController } from "../asyncBashJobs";
import { isInternalUrlPath, resolveInternalUrl } from "../internalUrls";
import type { AlphaContext, ToolDefinition } from "../types";
import { ensureInsideWorkspace, resolveWorkspaceDirectory, workspaceRoot } from "../workspace";

interface BashInput {
  command: string;
  env?: Record<string, string>;
  timeout?: number;
  cwd?: string;
  pty?: boolean;
  async?: boolean;
}

interface BashResult {
  output: string;
  exitCode: number | string;
  timedOut: boolean;
  cwd?: string;
  env?: Record<string, string>;
  artifactId?: string;
}

interface BashSessionState {
  cwd: string;
  env: Record<string, string>;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 3600;
const STATE_FILE_PREFIX = "alpha-bash-state-";
const bashSessions = new Map<string, BashSessionState>();

const DEDICATED_TOOL_RULES: Array<{ pattern: RegExp; tool: string; message: string }> = [
  { pattern: /^\s*(?:cat|head|tail|less|more)\b/, tool: "read", message: "Use read for file content inspection." },
  { pattern: /^\s*(?:ls|dir)\b/, tool: "read", message: "Use read on a directory path for directory listings." },
  { pattern: /^\s*(?:grep|rg|ag|ack)\b/, tool: "search", message: "Use search for text search." },
  { pattern: /^\s*(?:find|fd)\b/, tool: "find", message: "Use find for file discovery." },
  { pattern: /\b(?:sed|perl|awk)\s+[^|\n\r;]*\s-i\b/, tool: "edit", message: "Use edit for in-place file changes." },
  { pattern: /(?:^|[\s;&|])(?:echo|printf)\b[\s\S]*(?:>|>>)/, tool: "write", message: "Use write for creating whole files and edit for modifying existing files." },
];

export const bashTool: ToolDefinition = {
  name: "bash",
  summary: "Execute a shell command in the workspace.",
  async run(args, ctx) {
    const config = vscode.workspace.getConfiguration("alpha");
    let input = normalizeCommandInput(parseBashInput(args));

    if (config.get<boolean>("bash.interceptDedicatedToolCommands", true)) {
      assertNotDedicatedToolCommand(input.command);
    }

    const fixup = config.get<boolean>("bash.stripTrailingHeadTail", true)
      ? applyBashFixups(input.command)
      : { command: input.command, stripped: [] };
    input = { ...input, command: fixup.command };

    const timeoutSeconds = clampTimeout(input.timeout);
    const cwd = input.cwd ? await resolveWorkspaceDirectory(input.cwd) : workspaceRoot();
    ensureInsideWorkspace(cwd);
    const command = await expandInternalUrlsForBash(input.command, ctx);
    input = { ...input, command };

    await ensureToolPermission(
      { name: "bash", approval: bashApproval, formatApprovalDetails: bashApprovalDetails },
      input,
      ctx,
    );

    const session = getBashSession(ctx.sessionKey, cwd.fsPath);

    if (input.async) {
      const job = ctx.bashJobs.add({
        type: "bash",
        command: input.command,
        cwd: effectiveCwd(input, session, cwd.fsPath),
        status: "running",
      });
      void runAsyncBashJob(job.id, input, cwd, timeoutSeconds, ctx, session);
      return {
        markdown: [
          `Background bash job ${job.id} started.`,
          `Command: \`${input.command}\``,
          `Timeout: ${timeoutSeconds}s`,
          fixup.stripped.length ? `Note: stripped output-limiting suffix: ${fixup.stripped.join(" ")}` : undefined,
        ].filter(Boolean).join("\n"),
      };
    }

    const started = performance.now();
    const result = input.pty
      ? await runPtyCapture(input, cwd, session, timeoutSeconds, ctx.token)
      : await runShellCommand(input.command, {
          cwd: effectiveCwd(input, session, cwd.fsPath),
          env: mergedEnv(session, input.env),
          timeoutMs: timeoutSeconds * 1000,
          token: ctx.token,
          captureState: input.cwd ? undefined : session,
        });
    applySessionState(session, result, input.cwd === undefined);
    const wallMs = Math.round(performance.now() - started);

    return {
      markdown: formatBashResult(result, {
        ctx,
        label: "bash",
        maxVisibleBytes: config.get<number>("bash.maxVisibleBytes", 120000),
        timeoutSeconds,
        wallMs,
        prefixLines: fixup.stripped.length ? [`Note: stripped output-limiting suffix: ${fixup.stripped.join(" ")}`] : [],
      }),
    };
  },
};

function parseBashInput(args: string): BashInput {
  const trimmed = args.trim();
  if (!trimmed) throw new Error("bash requires a command.");

  if (!trimmed.startsWith("{")) {
    return { command: trimmed };
  }

  const parsed = JSON.parse(trimmed) as Partial<BashInput>;
  if (typeof parsed.command !== "string" || !parsed.command.trim()) {
    throw new Error("bash command is required.");
  }

  return {
    command: parsed.command,
    env: parsed.env === undefined ? undefined : normalizeEnv(parsed.env),
    timeout: parsed.timeout,
    cwd: parsed.cwd,
    pty: parsed.pty,
    async: parsed.async,
  };
}

function normalizeEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("bash env must be an object of string values.");
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new Error(`Invalid bash env name: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`bash env ${key} must be a string.`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizeCommandInput(input: BashInput): BashInput {
  if (input.cwd) return input;
  const match = input.command.match(/^cd[ \t]+((?:[^&\\\n\r]|\\.)+?)[ \t]*&&[ \t]*/);
  if (!match || /[$`(]/.test(match[1])) return input;
  return {
    ...input,
    cwd: match[1].trim().replace(/^["']|["']$/g, ""),
    command: input.command.slice(match[0].length),
  };
}

function assertNotDedicatedToolCommand(command: string): void {
  for (const rule of DEDICATED_TOOL_RULES) {
    if (rule.pattern.test(command)) {
      throw new Error(`Blocked bash command. ${rule.message}\nSuggested tool: ${rule.tool}\nOriginal command: ${command}`);
    }
  }
}

function applyBashFixups(command: string): { command: string; stripped: string[] } {
  if (command.includes("\n")) return { command, stripped: [] };
  let next = command;
  const stripped: string[] = [];

  const headTail = next.match(/\s*\|&?\s*(?:head|tail)(?:\s+-n\s+\d+|\s+\d+)?\s*$/);
  if (headTail) {
    stripped.push(headTail[0].trim());
    next = next.slice(0, headTail.index).trimEnd();
  }

  const stderrMerge = next.match(/\s+2>&1\s*$/);
  if (stderrMerge && !/[|<>]/.test(next.slice(0, stderrMerge.index))) {
    stripped.push(stderrMerge[0].trim());
    next = next.slice(0, stderrMerge.index).trimEnd();
  }

  return { command: next || command, stripped };
}

function getBashSession(sessionKey: string, initialCwd: string): BashSessionState {
  const existing = bashSessions.get(sessionKey);
  if (existing) return existing;
  const created: BashSessionState = { cwd: initialCwd, env: {} };
  bashSessions.set(sessionKey, created);
  return created;
}

function effectiveCwd(input: BashInput, session: BashSessionState, fallbackCwd: string): string {
  return input.cwd ? fallbackCwd : session.cwd;
}

function mergedEnv(session: BashSessionState, env: Record<string, string> | undefined): Record<string, string> {
  return { ...session.env, ...(env ?? {}) };
}

function applySessionState(session: BashSessionState, result: BashResult, persistent: boolean): void {
  if (!persistent) return;
  if (result.cwd) session.cwd = result.cwd;
  if (result.env) session.env = result.env;
}

async function expandInternalUrlsForBash(command: string, ctx: AlphaContext): Promise<string> {
  const pattern = /\b(?:artifact|local|memory|omp|history):\/\/[^\s'"`)]+/g;
  const matches = [...command.matchAll(pattern)];
  if (!matches.length) return command;

  let expanded = command;
  for (const match of matches.reverse()) {
    const url = match[0];
    if (!isInternalUrlPath(url)) continue;
    const resource = await resolveInternalUrl(url, ctx);
    if (!resource.sourcePath) {
      throw new Error(`Cannot use ${url} in bash because it does not resolve to a filesystem path. Use read instead.`);
    }
    expanded = `${expanded.slice(0, match.index)}${shellQuote(resource.sourcePath)}${expanded.slice((match.index ?? 0) + url.length)}`;
  }
  return expanded;
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, "\"\"")}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function wrapCommandForStateCapture(command: string, stateFile: string): string {
  const quotedStateFile = shellQuote(stateFile);
  const quotedNode = shellQuote(process.execPath);
  const escapedCommand = command.replace(/\r\n/g, "\n");
  return [
    escapedCommand,
    "__alpha_status=$?",
    `${quotedNode} -e ` + shellQuote([
      "const fs=require('fs');",
      "const path=process.argv[1];",
      "const env={};",
      "for (const [k,v] of Object.entries(process.env)) {",
      "if (!/^(__CF|PWD|OLDPWD|SHLVL|_|TERM_PROGRAM|VSCODE_)/.test(k)) env[k]=v;",
      "}",
      "fs.writeFileSync(path, JSON.stringify({cwd:process.cwd(), env}), 'utf8');",
    ].join("")) + ` ${quotedStateFile}`,
    "exit $__alpha_status",
  ].join("\n");
}

async function readCapturedShellState(filePath: string): Promise<{ cwd?: string; env?: Record<string, string> } | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { cwd?: unknown; env?: unknown };
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd : undefined;
    const env = parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)
      ? Object.fromEntries(Object.entries(parsed.env as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string>
      : undefined;
    return { cwd, env };
  } catch {
    return undefined;
  }
}

function clampTimeout(timeout: number | undefined): number {
  if (timeout === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeout)) throw new Error("bash timeout must be a finite number.");
  return Math.max(MIN_TIMEOUT_SECONDS, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(timeout)));
}

function runPtyTerminal(input: BashInput, cwd: vscode.Uri): { markdown: string } {
  const terminal = vscode.window.createTerminal({
    name: "Alpha Bash",
    cwd,
    env: input.env,
  });
  terminal.show();
  terminal.sendText(input.command, true);
  return {
    markdown: [
      "Started command in VS Code terminal because `pty=true` was requested.",
      "Alpha cannot capture PTY output through the Copilot chat participant API; use non-PTY bash when the model needs output.",
      `Command: \`${input.command}\``,
    ].join("\n"),
  };
}

async function runPtyCapture(
  input: BashInput,
  cwd: vscode.Uri,
  session: BashSessionState,
  timeoutSeconds: number,
  token: vscode.CancellationToken,
): Promise<BashResult> {
  if (process.platform === "win32") {
    runPtyTerminal(input, cwd);
    return {
      output: [
        "Started command in VS Code terminal because `pty=true` was requested.",
        "PTY output capture is not exposed by the VS Code chat participant API on this platform.",
      ].join("\n"),
      exitCode: "terminal",
      timedOut: false,
    };
  }

  const transcript = path.join(os.tmpdir(), `alpha-pty-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const shell = process.env.SHELL || "/bin/sh";
  const args = process.platform === "darwin"
    ? ["-q", transcript, shell, "-lc", input.command]
    : ["-q", "-c", input.command, transcript];
  const result = await runShellCommand("script", {
    cwd: effectiveCwd(input, session, cwd.fsPath),
    env: mergedEnv(session, input.env),
    timeoutMs: timeoutSeconds * 1000,
    token,
    argv: args,
    captureState: input.cwd ? undefined : session,
  });
  try {
    const transcriptText = await fs.readFile(transcript, "utf8");
    result.output = transcriptText.trim() || result.output;
  } catch {
    result.output = result.output || "PTY capture did not produce a transcript.";
  } finally {
    void fs.rm(transcript, { force: true });
  }
  return result;
}

async function runAsyncBashJob(
  jobId: string,
  input: BashInput,
  cwd: vscode.Uri,
  timeoutSeconds: number,
  ctx: AlphaContext,
  session: BashSessionState,
): Promise<void> {
  const started = performance.now();
  const controller = new AbortController();
  registerAsyncBashController(jobId, controller);
  try {
    const result = await runShellCommand(input.command, {
      cwd: effectiveCwd(input, session, cwd.fsPath),
      env: mergedEnv(session, input.env),
      timeoutMs: timeoutSeconds * 1000,
      signal: controller.signal,
      captureState: input.cwd ? undefined : session,
    });
    applySessionState(session, result, input.cwd === undefined);
    const wallMs = Math.round(performance.now() - started);
    const artifact = ctx.artifacts.add(`bash job ${jobId} output`, result.output);
    const cancelled = controller.signal.aborted;
    ctx.bashJobs.update(jobId, {
      status: cancelled ? "cancelled" : result.exitCode === 0 && !result.timedOut ? "completed" : "failed",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      wallTimeMs: wallMs,
      artifactId: artifact.id,
      output: previewOutput(result.output, 4000),
    });
    void vscode.window.showInformationMessage(`Alpha bash job ${jobId} ${cancelled ? "cancelled" : result.exitCode === 0 && !result.timedOut ? "completed" : "failed"}: artifact://${artifact.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.bashJobs.update(jobId, { status: controller.signal.aborted ? "cancelled" : "failed", error: message });
    void vscode.window.showErrorMessage(`Alpha bash job ${jobId} failed: ${message}`);
  } finally {
    unregisterAsyncBashController(jobId);
  }
}

function runShellCommand(
  command: string,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
    token?: vscode.CancellationToken;
    signal?: AbortSignal;
    argv?: string[];
    captureState?: BashSessionState;
  },
): Promise<BashResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const stateFile = opts.captureState ? path.join(os.tmpdir(), `${STATE_FILE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}.json`) : undefined;
    const shellCommand = stateFile ? wrapCommandForStateCapture(command, stateFile) : command;

    const child = spawn(opts.argv ? command : shellCommand, opts.argv ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: opts.argv ? false : true,
      windowsHide: true,
    });

    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);

    const subscription = opts.token?.onCancellationRequested(() => {
      timedOut = true;
      child.kill();
    });
    const abortHandler = (): void => {
      timedOut = true;
      child.kill();
    };
    opts.signal?.addEventListener("abort", abortHandler, { once: true });

    const finish = async (exitCode: number | string): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.dispose();
      opts.signal?.removeEventListener("abort", abortHandler);
      const state = stateFile ? await readCapturedShellState(stateFile) : undefined;
      if (stateFile) void fs.rm(stateFile, { force: true });
      resolve({ output: output || "(no output)", exitCode, timedOut, cwd: state?.cwd, env: state?.env });
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      output += error.message;
      void finish("error");
    });
    child.on("close", (code, signal) => {
      void finish(code ?? signal ?? "unknown");
    });
  });
}


function formatBashResult(
  result: BashResult,
  opts: {
    ctx: AlphaContext;
    label: string;
    maxVisibleBytes: number;
    timeoutSeconds: number;
    wallMs: number;
    prefixLines?: string[];
  },
): string {
  const artifact = shouldStoreArtifact(result.output, opts.maxVisibleBytes) ? opts.ctx.artifacts.add(`${opts.label} output`, result.output) : undefined;
  if (artifact) result.artifactId = artifact.id;
  const lines = [
    ...(opts.prefixLines ?? []),
    "```text",
    truncateOutput(result.output, opts.maxVisibleBytes),
    "```",
    `[Wall: ${formatDuration(opts.wallMs)} | Exit: ${result.exitCode}${result.timedOut ? ` | Timed out after ${opts.timeoutSeconds}s` : ""}]`,
  ];

  if (artifact) {
    lines.push(`[raw output: artifact://${artifact.id}]`);
  }

  return lines.join("\n");
}

function shouldStoreArtifact(output: string, maxVisibleBytes: number): boolean {
  return Buffer.from(output, "utf8").byteLength > maxVisibleBytes;
}

function truncateOutput(output: string, maxVisibleBytes: number): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= maxVisibleBytes) return output.trimEnd();
  return `${Buffer.from(bytes.subarray(0, maxVisibleBytes)).toString("utf8").trimEnd()}\n...[truncated by Alpha; full output available via artifact://]`;
}

function previewOutput(output: string, maxVisibleBytes: number): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= maxVisibleBytes) return output;
  return `${Buffer.from(bytes.subarray(0, maxVisibleBytes)).toString("utf8")}\n...[truncated preview; full output in artifact]`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
