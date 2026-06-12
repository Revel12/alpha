import * as vscode from "vscode";
import { applyWorkspaceEdits, buildWorkspaceEdits } from "../patch/hashline";
import type { ToolDefinition } from "../types";

export const editTool: ToolDefinition = {
  name: "edit",
  summary: "Apply OMP-style hashline edits. Set alpha.edit.defaultMode=preview to queue instead.",
  async run(args, ctx) {
    const config = vscode.workspace.getConfiguration("alpha");
    const mode = config.get<"apply" | "preview">("edit.defaultMode", "apply");
    const maxBytes = config.get<number>("read.maxBytes", 200000);
    const edits = await buildWorkspaceEdits(args, maxBytes);

    if (mode === "preview") {
      const pending = ctx.pendingEdits.add({ label: "hashline edit", edits });
      return { markdown: `Queued pending edit \`${pending.id}\` with ${edits.length} change(s). Use \`resolve ${pending.id}\` to apply.` };
    }

    const ok = await applyWorkspaceEdits(edits);
    return { markdown: ok ? `Applied ${edits.length} edit(s).` : "VS Code rejected the workspace edit." };
  },
};
