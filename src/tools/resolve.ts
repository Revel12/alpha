import * as vscode from "vscode";
import { contentTag } from "../hash";
import { applyWorkspaceEdits } from "../patch/hashline";
import type { ToolDefinition } from "../types";
import { readOpenDocumentText, relativePath, resolveWorkspaceFile } from "../workspace";

interface ResolveInput {
  action: "apply" | "discard";
  reason: string;
  extra?: {
    id?: string;
  };
}

export const resolveTool: ToolDefinition = {
  name: "resolve",
  summary: "Hidden tool that applies or discards pending preview work.",
  async run(args, ctx) {
    const input = parseResolveInput(args);
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
    if (parsed.action !== "apply" && parsed.action !== "discard") {
      throw new Error("resolve action must be apply or discard.");
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

  throw new Error("resolve action must be apply or discard.");
}
