import * as vscode from "vscode";
import { includeGlobsForSearch, parseSearchInput, renderSearchResults, searchText, truncateSearchOutput } from "../searchCore";
import type { SearchFileResult } from "../searchCore";
import type { ToolDefinition } from "../types";
import { readText, relativePath } from "../workspace";

export const searchTool: ToolDefinition = {
  name: "search",
  summary: "Search text across workspace files and return OMP-style hashline anchors. Example: search TODO",
  async run(args, ctx) {
    const config = vscode.workspace.getConfiguration("alpha");
    const input = parseSearchInput(args, {
      contextBefore: config.get<number>("search.contextBefore", 1),
      contextAfter: config.get<number>("search.contextAfter", 1),
      maxResults: config.get<number>("search.maxResults", 80),
    });
    const maxFiles = config.get<number>("search.maxFiles", 4000);
    const maxReadBytes = config.get<number>("read.maxBytes", 200000);
    const maxVisibleBytes = config.get<number>("search.maxVisibleBytes", 120000);
    const includes = includeGlobsForSearch(input);
    const uniqueFiles = new Map<string, vscode.Uri>();
    for (const include of includes) {
      const found = await vscode.workspace.findFiles(include, "**/{node_modules,out,dist,build,.git,coverage,target,vendor}/**", maxFiles + input.skip);
      for (const uri of found) uniqueFiles.set(uri.toString(), uri);
    }
    const files = [...uniqueFiles.values()]
      .sort((left, right) => relativePath(left).localeCompare(relativePath(right)))
      .slice(input.skip, input.skip + maxFiles);
    const results: SearchFileResult[] = [];
    let matchCount = 0;
    let limited = false;

    for (const uri of files) {
      if (matchCount >= input.maxResults) {
        limited = true;
        break;
      }

      let text: string;
      try {
        text = await readText(uri, maxReadBytes);
      } catch {
        continue;
      }

      const path = relativePath(uri);
      const snapshot = ctx.snapshots.record(path, text);
      const result = searchText(path, snapshot.tag, text, input, input.maxResults - matchCount);
      if (!result) continue;
      matchCount += result.matchCount;
      if (matchCount >= input.maxResults) limited = true;
      results.push(result);
    }

    const rendered = renderSearchResults(results, input, limited);
    const truncated = truncateSearchOutput(rendered.text, maxVisibleBytes);
    if (!truncated.truncated) return { markdown: truncated.visible };

    const artifact = ctx.artifacts.add("search output", rendered.text);
    return { markdown: `${truncated.visible}\n\n[raw output: artifact://${artifact.id}]` };
  },
};
