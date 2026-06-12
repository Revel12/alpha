import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
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
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 3600;

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

    if (input.pty) {
      return runPtyTerminal(input, cwd);
    }

    if (input.async) {
      const job = ctx.bashJobs.add({
        command: input.command,
        cwd: cwd.fsPath,
        status: "running",
      });
      void runAsyncBashJob(job.id, input, cwd, timeoutSeconds, ctx);
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
    const result = await runShellCommand(input.command, {
      cwd: cwd.fsPath,
      env: input.env,
      timeoutMs: timeoutSeconds * 1000,
      token: ctx.token,
    });
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

async function runAsyncBashJob(
  jobId: string,
  input: BashInput,
  cwd: vscode.Uri,
  timeoutSeconds: number,
  ctx: AlphaContext,
): Promise<void> {
  const started = performance.now();
  try {
    const result = await runShellCommand(input.command, {
      cwd: cwd.fsPath,
      env: input.env,
      timeoutMs: timeoutSeconds * 1000,
    });
    const wallMs = Math.round(performance.now() - started);
    const artifact = ctx.artifacts.add(`bash job ${jobId} output`, result.output);
    ctx.bashJobs.update(jobId, {
      status: result.exitCode === 0 && !result.timedOut ? "completed" : "failed",
      output: result.output,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      wallTimeMs: wallMs,
      artifactId: artifact.id,
    });
    void vscode.window.showInformationMessage(`Alpha bash job ${jobId} ${result.exitCode === 0 && !result.timedOut ? "completed" : "failed"}: artifact://${artifact.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.bashJobs.update(jobId, { status: "failed", error: message });
    void vscode.window.showErrorMessage(`Alpha bash job ${jobId} failed: ${message}`);
  }
}

function runShellCommand(
  command: string,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
    token?: vscode.CancellationToken;
  },
): Promise<BashResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: true,
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

    const finish = (exitCode: number | string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.dispose();
      resolve({ output: output || "(no output)", exitCode, timedOut });
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      output += error.message;
      finish("error");
    });
    child.on("close", (code, signal) => {
      finish(code ?? signal ?? "unknown");
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
