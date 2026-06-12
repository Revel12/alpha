import { applyWorkspaceEdits } from "../patch/hashline";
import type { ToolDefinition } from "../types";

export const resolveTool: ToolDefinition = {
  name: "resolve",
  summary: "List, apply, or clear pending edits. Examples: resolve list, resolve apply <id>, resolve clear",
  async run(args, ctx) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const op = parts[0] ?? "list";

    if (op === "list") {
      const edits = ctx.pendingEdits.list();
      if (!edits.length) return { markdown: "No pending edits." };
      return { markdown: edits.map((edit) => `- ${edit.id}: ${edit.label} (${edit.edits.length} changes)`).join("\n") };
    }

    if (op === "clear") {
      ctx.pendingEdits.clear();
      return { markdown: "Cleared pending edits." };
    }

    if (op === "apply") {
      const id = parts[1];
      if (!id) throw new Error("resolve apply requires an edit id.");
      const pending = ctx.pendingEdits.get(id);
      if (!pending) throw new Error(`No pending edit found for ${id}.`);
      const ok = await applyWorkspaceEdits(pending.edits);
      if (ok) ctx.pendingEdits.remove(id);
      return { markdown: ok ? `Applied ${id}.` : `VS Code rejected ${id}.` };
    }

    throw new Error("Unknown resolve operation. Use list, apply <id>, or clear.");
  },
};
