import * as vscode from "vscode";
import type { ToolDefinition } from "../types";
import { relativePath } from "../workspace";

export const findTool: ToolDefinition = {
  name: "find",
  summary: "Find files by glob. Example: find src/**/*.ts",
  async run(args) {
    const pattern = args.trim() || "**/*";
    const files = await vscode.workspace.findFiles(pattern, "**/{node_modules,out,dist,build,.git}/**", 200);
    if (!files.length) return { markdown: "No files found." };
    return { markdown: files.map((uri) => `- ${relativePath(uri)}`).join("\n") };
  },
};
