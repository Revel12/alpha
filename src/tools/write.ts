import * as vscode from "vscode";
import { renderAnchoredFile } from "../hash";
import type { ToolDefinition } from "../types";
import { relativePath, resolveWorkspaceFile, writeText } from "../workspace";

export const writeTool: ToolDefinition = {
  name: "write",
  summary: "Write a workspace file. First line is path; remaining text is file content.",
  async run(args) {
    const [pathLine, ...body] = args.replace(/\r\n/g, "\n").split("\n");
    if (!pathLine?.trim()) throw new Error("write requires a path on the first line.");
    const uri = await resolveWorkspaceFile(pathLine.trim());
    const content = body.join("\n");
    await writeText(uri, content);
    await vscode.window.showTextDocument(uri, { preview: false });
    return { markdown: [`Wrote ${relativePath(uri)}.`, renderAnchoredFile(relativePath(uri), content)].join("\n\n") };
  },
};
