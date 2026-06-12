import * as vscode from "vscode";
import { applyWorkspaceEdits, buildWorkspaceEdits } from "../patch/hashline";
import type { ToolDefinition } from "../types";
import { readText, relativePath } from "../workspace";

export const editTool: ToolDefinition = {
  name: "edit",
  summary: "Apply OMP-style hashline edits directly after validating snapshot tags and ranges.",
  async run(args, ctx) {
    const config = vscode.workspace.getConfiguration("alpha");
    const maxBytes = config.get<number>("read.maxBytes", 200000);
    const edits = await buildWorkspaceEdits(args, maxBytes, ctx.snapshots);

    const before = new Map<string, string>();
    for (const uri of uniqueUris(edits.map((edit) => edit.uri))) {
      before.set(uri.toString(), await readText(uri, maxBytes));
    }

    const ok = await applyWorkspaceEdits(edits);
    if (!ok) return { markdown: "VS Code rejected the workspace edit." };

    const changedUris = uniqueUris(edits.map((edit) => edit.uri));
    const snapshots: string[] = [];
    let anyChanged = false;
    for (const uri of changedUris) {
      const path = relativePath(uri);
      const next = await readText(uri, maxBytes);
      if (before.get(uri.toString()) !== next) {
        anyChanged = true;
      }
      const snapshot = ctx.snapshots.record(path, next);
      snapshots.push([
        `[${path}#${snapshot.tag}]`,
        compactDiff(before.get(uri.toString()) ?? "", next),
      ].join("\n"));
    }

    if (!anyChanged) {
      throw new Error("Edits parsed and applied cleanly, but produced no change. Re-read the file before issuing another edit.");
    }

    return { markdown: snapshots.join("\n\n") };
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

function compactDiff(before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start++;
  }

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (beforeEnd >= start && afterEnd >= start && beforeLines[beforeEnd] === afterLines[afterEnd]) {
    beforeEnd--;
    afterEnd--;
  }

  if (start > beforeEnd && start > afterEnd) {
    return "No changes.";
  }

  const lines = ["```diff"];
  for (let i = start; i <= beforeEnd; i++) {
    lines.push(`-${beforeLines[i]}`);
  }
  for (let i = start; i <= afterEnd; i++) {
    lines.push(`+${afterLines[i]}`);
  }
  lines.push("```");
  return lines.join("\n");
}
