import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureToolPermission } from "../approval";
import { evalApproval, evalApprovalDetails } from "../approvalCore";
import {
  formatEvalResult,
  parseEvalInput,
  runEvalCells,
  type EvalParams,
} from "../evalCore";
import { isInternalUrlPath, resolveInternalUrl, writeInternalUrl } from "../internalUrls";
import { runRegisteredAlphaTool } from "../toolRegistry";
import type { AlphaContext, ToolDefinition } from "../types";
import { ensureInsideWorkspace, readText, resolveWorkspaceFile, workspaceRoot } from "../workspace";

const MAX_VISIBLE_BYTES = 120_000;

export const evalTool: ToolDefinition = {
  name: "eval",
  summary: "Execute OMP-style JavaScript or Python eval cells.",
  async run(args, ctx) {
    const params = parseEvalInput(args);
    await ensureToolPermission(
      { name: "eval", approval: evalApproval, formatApprovalDetails: evalApprovalDetails },
      params,
      ctx,
    );
    const result = await runEvalCells(params, callbacksFor(ctx));
    const raw = formatEvalResult(result);
    const visible = truncateVisible(raw);
    const artifact = visible.truncated ? ctx.artifacts.add("eval output", raw) : undefined;
    return {
      markdown: artifact ? `${visible.text}\n\nRaw output: artifact://${artifact.id}` : raw,
    };
  },
};

export function evalDescription(): string {
  return [
    "Run code in persistent eval cells. Alpha supports OMP-style `cells` with `language`, `code`, `title`, `timeout`, and `reset`.",
    "JavaScript runs in a persistent Node VM per Alpha session. Python runs in a subprocess backend, so Python variables do not persist like OMP's IPython kernel yet.",
    "Helpers: display, print/console.log, read, write, append, tree, env, tool.<name>, parallel, pipeline, log, phase, budget.",
    "Host-limited in Alpha: IPython kernel sharing, completion(), agent() inside eval, rich image display blocks, and OMP TUI status trees.",
  ].join("\n");
}

function callbacksFor(ctx: AlphaContext) {
  const envValues: Record<string, string> = {};
  return {
    cwd: workspaceRoot().fsPath,
    sessionKey: ctx.sessionKey,
    signal: abortSignalFromCancellationToken(ctx.token),
    read: async (target: string) => {
      if (isInternalUrlPath(target)) return (await resolveInternalUrl(target, ctx)).content;
      const uri = await resolveWorkspaceFile(target);
      ensureInsideWorkspace(uri);
      return readText(uri, 200_000);
    },
    write: async (target: string, content: string) => {
      if (isInternalUrlPath(target)) {
        const resource = await writeInternalUrl(target, content, ctx);
        return resource.url;
      }
      const uri = await resolveWorkspaceFile(target);
      ensureInsideWorkspace(uri);
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, content, "utf8");
      return uri.fsPath;
    },
    append: async (target: string, content: string) => {
      if (isInternalUrlPath(target)) {
        const previous = await resolveInternalUrl(target, ctx).then((resource) => resource.content).catch(() => "");
        const resource = await writeInternalUrl(target, `${previous}${content}`, ctx);
        return resource.url;
      }
      const uri = await resolveWorkspaceFile(target);
      ensureInsideWorkspace(uri);
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.appendFile(uri.fsPath, content, "utf8");
      return uri.fsPath;
    },
    tree: async (target = ".", maxDepth = 3, showHidden = false) => {
      const uri = await resolveWorkspaceFile(target);
      ensureInsideWorkspace(uri);
      return renderTree(uri.fsPath, Math.max(0, maxDepth), showHidden);
    },
    tool: async (name: string, input: object) => {
      const result = await runRegisteredAlphaTool(name, input, ctx, new Set([name]));
      return result.markdown;
    },
    env: (key?: string, value?: string) => {
      if (key === undefined) return cleanEnv({ ...process.env, ...envValues });
      if (value === undefined) return envValues[key] ?? process.env[key];
      envValues[key] = value;
      return value;
    },
  };
}

function cleanEnv(input: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function truncateVisible(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_VISIBLE_BYTES) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, MAX_VISIBLE_BYTES).toString("utf8"), truncated: true };
}

async function renderTree(root: string, maxDepth: number, showHidden: boolean): Promise<string> {
  const lines: string[] = [];
  async function visit(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => showHidden || !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 200);
    for (const entry of entries) {
      const suffix = entry.isDirectory() ? "/" : "";
      lines.push(`${prefix}${entry.name}${suffix}`);
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), `${prefix}  `, depth + 1);
    }
  }
  lines.push(`${path.basename(root) || root}/`);
  await visit(root, "  ", 1);
  return lines.join("\n");
}

function abortSignalFromCancellationToken(token: { isCancellationRequested: boolean; onCancellationRequested?: (listener: () => void) => { dispose(): void } }): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested?.(() => controller.abort());
  return controller.signal;
}

export type { EvalParams };
