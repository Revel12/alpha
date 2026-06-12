import * as vscode from "vscode";
import type { ToolDefinition } from "../types";
import { readText, relativePath } from "../workspace";

export const searchTool: ToolDefinition = {
  name: "search",
  summary: "Search text across workspace files. Example: search TODO",
  async run(args) {
    const query = args.trim();
    if (!query) throw new Error("search requires a query.");
    const config = vscode.workspace.getConfiguration("alpha");
    const limit = config.get<number>("search.maxResults", 80);
    const files = await vscode.workspace.findFiles("**/*", "**/{node_modules,out,dist,build,.git}/**", 2000);
    const results: string[] = [];

    for (const uri of files) {
      if (results.length >= limit) break;
      let text: string;
      try {
        text = await readText(uri, 500000);
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].toLowerCase().includes(query.toLowerCase())) continue;
        results.push(`${relativePath(uri)}:${index + 1}: ${lines[index].trim()}`);
        if (results.length >= limit) break;
      }
    }

    return { markdown: results.length ? results.join("\n") : "No matches found." };
  },
};
