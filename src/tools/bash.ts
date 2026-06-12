import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import type { ToolDefinition } from "../types";
import { ensureInsideWorkspace, resolveWorkspaceDirectory, workspaceRoot } from "../workspace";

interface BashInput {
  command: string;
  env?: Record<string, string>;
  timeout?: number;
  cwd?: string;
  pty?: boolean;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 3600;
const MAX_OUTPUT_BYTES = 120000;

export const bashTool: ToolDefinition = {
  name: "bash",
  summary: "Execute a shell command in the workspace.",
  async run(args, ctx) {
    const input = parseBashInput(args);
    const timeoutSeconds = clampTimeout(input.timeout);
    const cwd = input.cwd ? await resolveWorkspaceDirectory(input.cwd) : workspaceRoot();
    ensureInsideWorkspace(cwd);

    const started = performance.now();
    const result = await runShellCommand(input.command, {
      cwd: cwd.fsPath,
      env: input.env,
      timeoutMs: timeoutSeconds * 1000,
      token: ctx.token,
    });
    const wallMs = Math.round(performance.now() - started);

    const lines = [
      "```text",
      truncateOutput(result.output),
      "```",
      `[Wall: ${formatDuration(wallMs)} | Exit: ${result.exitCode}${result.timedOut ? ` | Timed out after ${timeoutSeconds}s` : ""}]`,
    ];

    if (input.pty) {
      lines.push("Note: Alpha accepted pty for OMP schema compatibility, but this VS Code participant runs non-PTY shell commands.");
    }

    return { markdown: lines.join("\n") };
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

  const env = parsed.env === undefined ? undefined : normalizeEnv(parsed.env);
  return {
    command: parsed.command,
    env,
    timeout: parsed.timeout,
    cwd: parsed.cwd,
    pty: parsed.pty,
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

function clampTimeout(timeout: number | undefined): number {
  if (timeout === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeout)) throw new Error("bash timeout must be a finite number.");
  return Math.max(MIN_TIMEOUT_SECONDS, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(timeout)));
}

function runShellCommand(
  command: string,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
    token: vscode.CancellationToken;
  },
): Promise<{ output: string; exitCode: number | string; timedOut: boolean }> {
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

    const finish = (exitCode: number | string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription.dispose();
      resolve({ output: output || "(no output)", exitCode, timedOut });
    };

    const kill = (): void => {
      timedOut = true;
      child.kill();
    };

    const timer = setTimeout(kill, opts.timeoutMs);
    const subscription = opts.token.onCancellationRequested(() => {
      timedOut = true;
      child.kill();
    });

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

function truncateOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) return output.trimEnd();
  return `${Buffer.from(bytes.subarray(0, MAX_OUTPUT_BYTES)).toString("utf8").trimEnd()}\n...[truncated by Alpha; rerun with a narrower command if exact trailing output is needed]`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
