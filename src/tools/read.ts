import * as vscode from "vscode";
import { renderAnchoredFile } from "../hash";
import type { ToolDefinition } from "../types";
import { readText, relativePath, resolveWorkspaceFile } from "../workspace";

export const readTool: ToolDefinition = {
  name: "read",
  summary: "Read a workspace file, active editor, or selection and return hash-anchored text.",
  async run(args, ctx) {
    const config = vscode.workspace.getConfiguration("alpha");
    const maxBytes = config.get<number>("read.maxBytes", 200000);
    const target = args.trim();
    let uri: vscode.Uri;
    let content: string;

    if (!target || target === "active") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) throw new Error("No active editor.");
      uri = editor.document.uri;
      content = editor.document.getText();
    } else {
      uri = await resolveWorkspaceFile(target);
      content = await readText(uri, maxBytes);
    }

    return { markdown: renderAnchoredFile(relativePath(uri), content) };
  },
};
