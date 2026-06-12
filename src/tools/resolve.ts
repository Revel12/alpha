import { applyWorkspaceEdits } from "../patch/hashline";
import type { ToolDefinition } from "../types";

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

    const ok = await applyWorkspaceEdits(pending.edits);
    if (ok) ctx.pendingEdits.remove(pending.id);
    return { markdown: ok ? `Applied ${pending.id}. Reason: ${input.reason}` : `VS Code rejected ${pending.id}.` };
  },
};

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
