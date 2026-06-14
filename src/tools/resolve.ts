import * as vscode from "vscode";
import { contentTag } from "../hash";
import { resolveInternalUrl } from "../internalUrls";
import { applyWorkspaceEdits } from "../patch/hashline";
import { DEFAULT_PLAN_FILE, isPlanModeActive, renderPlanReview, updatePlanMode } from "../planMode";
import type { ToolDefinition } from "../types";
import { readOpenDocumentText, relativePath, resolveWorkspaceFile } from "../workspace";

interface ResolveInput {
  action: "apply" | "refine" | "discard";
  reason: string;
  extra?: {
    id?: string;
    title?: string;
    planPath?: string;
  };
}

export const resolveTool: ToolDefinition = {
  name: "resolve",
  summary: "Hidden tool that applies or discards pending preview work.",
  async run(args, ctx) {
    const input = parseResolveInput(args);
    if (isPlanModeActive(ctx) && !input.extra?.id) {
      return await resolvePlanMode(input, ctx);
    }

    const pending = input.extra?.id ? ctx.pendingEdits.get(input.extra.id) : ctx.pendingEdits.list()[0];

    if (!pending) {
      if (input.action === "discard") {
        return { markdown: "Nothing to discard; no pending action remains." };
      }
      throw new Error("No pending action to resolve. Nothing to apply or discard.");
    }

    if (input.action === "discard") {
      ctx.pendingEdits.remove(pending.id);
      return { markdown: `Discarded ${pending.id}. Reason: ${input.reason}` };
    }

    const maxBytes = vscode.workspace.getConfiguration("alpha").get<number>("read.maxBytes", 200000);
    const stale = await stalePendingFiles(pending.expectedTags, maxBytes);
    if (stale.length) {
      return {
        markdown: `Preview is stale / no longer matches; no edits were applied.\n${stale.map((item) => `- ${item.path}: expected ${item.expected}, current ${item.current}`).join("\n")}`,
      };
    }

    const ok = await applyWorkspaceEdits(pending.edits);
    if (ok) ctx.pendingEdits.remove(pending.id);
    if (!ok) return { markdown: `VS Code rejected ${pending.id}.` };

    const freshTags: string[] = [];
    for (const uri of uniqueUris(pending.edits.map((edit) => edit.uri))) {
      const filePath = relativePath(uri);
      const text = await readOpenDocumentText(uri, maxBytes);
      const snapshot = ctx.snapshots.record(filePath, text);
      freshTags.push(`[${filePath}#${snapshot.tag}]`);
    }
    const tagText = freshTags.length ? `\n${freshTags.join("\n")}` : "";
    return { markdown: `Applied ${pending.id}. Reason: ${input.reason}${tagText}` };
  },
};

async function stalePendingFiles(expectedTags: Record<string, string> | undefined, maxBytes: number): Promise<Array<{ path: string; expected: string; current: string }>> {
  if (!expectedTags) return [];
  const stale: Array<{ path: string; expected: string; current: string }> = [];
  for (const [filePath, expected] of Object.entries(expectedTags)) {
    const uri = await resolveWorkspaceFile(filePath);
    const text = await readOpenDocumentText(uri, maxBytes);
    const current = contentTag(text);
    if (current !== expected.toUpperCase()) stale.push({ path: filePath, expected: expected.toUpperCase(), current });
  }
  return stale;
}

function uniqueUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const unique: vscode.Uri[] = [];
  for (const uri of uris) {
    if (seen.has(uri.toString())) continue;
    seen.add(uri.toString());
    unique.push(uri);
  }
  return unique;
}

function parseResolveInput(args: string): ResolveInput {
  const trimmed = args.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Partial<ResolveInput>;
    if (parsed.action !== "apply" && parsed.action !== "refine" && parsed.action !== "discard") {
      throw new Error("resolve action must be apply, refine, or discard.");
    }
    if (!parsed.reason?.trim()) {
      throw new Error("resolve reason is required.");
    }
    return { action: parsed.action, reason: parsed.reason, extra: parsed.extra };
  }

  return parseLegacyResolveInput(trimmed);
}

function parseLegacyResolveInput(input: string): ResolveInput {
  const parts = input.split(/\s+/).filter(Boolean);
  const op = parts[0] ?? "apply";

  if (op === "clear" || op === "discard") {
    return { action: "discard", reason: "Legacy resolve discard request.", extra: { id: parts[1] } };
  }

  if (op === "apply" || op === "list") {
    return { action: "apply", reason: "Legacy resolve apply request.", extra: { id: parts[1] } };
  }

  throw new Error("resolve action must be apply, refine, or discard.");
}

async function resolvePlanMode(input: ResolveInput, ctx: Parameters<ToolDefinition["run"]>[1]) {
  const state = ctx.planMode;
  if (!state?.active) throw new Error("Plan mode is not active.");

  if (input.action === "discard") {
    ctx.planMode = updatePlanMode(state, { active: false, approvedPlan: undefined, approvedPlanPath: undefined, pendingApproval: false });
    ctx.persistSession?.();
    return { markdown: `Discarded Alpha plan mode. Reason: ${input.reason}` };
  }

  if (input.action === "refine") {
    ctx.planMode = updatePlanMode(state, { pendingApproval: false });
    ctx.persistSession?.();
    return { markdown: `Continuing Alpha plan mode. Reason: ${input.reason}\n\nUpdate \`${ctx.planMode.planPath}\` and call \`resolve\` with \`action: "apply"\` when ready.` };
  }

  const planPath = normalizedPlanPath(input.extra?.planPath || state.planPath || planPathFromTitle(input.extra?.title) || DEFAULT_PLAN_FILE);
  const plan = await readPlanText(planPath, ctx);
  ctx.planMode = updatePlanMode(state, {
    active: true,
    approvedPlan: plan,
    approvedPlanPath: planPath,
    planPath,
    pendingApproval: true,
  });
  ctx.persistSession?.();

  return {
    markdown: [
      "Plan submitted for user approval in chat. Alpha remains in read-only plan mode.",
      "",
      `Reason: ${input.reason}`,
      "",
      renderPlanReview(ctx.planMode),
      "",
      "Type one of:",
      "- `approve and implement`",
      "- `refine: <what to change>`",
      "- `discard plan`",
    ].join("\n"),
    details: { stopAfterToolResult: true },
  };
}

async function readPlanText(planPath: string, ctx: Parameters<ToolDefinition["run"]>[1]): Promise<string> {
  try {
    const resource = await resolveInternalUrl(planPath, ctx);
    if (!resource.content.trim()) throw new Error("empty plan");
    return resource.content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read plan at ${planPath}: ${message}. Write the plan to local:// first, then call resolve apply.`);
  }
}

function normalizedPlanPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_PLAN_FILE;
  return trimmed.startsWith("local://") ? trimmed : `local://${trimmed.replace(/^\/+/, "")}`;
}

function planPathFromTitle(title: string | undefined): string | undefined {
  if (!title?.trim()) return undefined;
  const slug = title.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug ? `local://${slug}-plan.md` : undefined;
}
