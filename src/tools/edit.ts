import * as vscode from "vscode";
import { renderAnchoredFile } from "../hash";
import { applyWorkspaceEdits, buildWorkspaceEdits } from "../patch/hashline";
import type { ToolDefinition } from "../types";
import { readText, relativePath } from "../workspace";

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
      return {
        markdown: `Queued pending edit \`${pending.id}\` with ${edits.length} change(s). Use hidden resolve action apply or discard when prompted.`,
      };
    }

    const ok = await applyWorkspaceEdits(edits);
    if (!ok) return { markdown: "VS Code rejected the workspace edit." };

    const changedUris = uniqueUris(edits.map((edit) => edit.uri));
    const snapshots = await Promise.all(
      changedUris.map(async (uri) => renderAnchoredFile(relativePath(uri), await readText(uri, maxBytes))),
    );

    return { markdown: [`Applied ${edits.length} edit(s).`, ...snapshots].join("\n\n") };
  },
};

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
