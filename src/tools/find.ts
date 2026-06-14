import * as vscode from "vscode";
import { findExcludeGlob, findIncludeGlobs, matchesFindGlob, mergeFindEntries, parseFindInput, renderFindResults, truncateFindOutput } from "../findCore";
import type { FindEntry } from "../findCore";
import { isInternalUrlPath, resolveInternalUrl } from "../internalUrls";
import type { ToolDefinition } from "../types";
import { readDirectory, relativePath, stat, workspaceRoot } from "../workspace";

export const findTool: ToolDefinition = {
  name: "find",
  summary: "Find files and directories matching OMP-style paths globs. Example: find {\"paths\":[\"src/**/*.ts\"]}",
  async run(args, ctx) {
    const input = parseFindInput(args);
    const config = vscode.workspace.getConfiguration("alpha");
    const maxVisibleBytes = config.get<number>("find.maxVisibleBytes", 50000);
    const startedAt = Date.now();
    const timeoutMs = Math.round(input.timeout * 1000);
    const entries: FindEntry[] = [];
    const internalPaths = input.paths.filter(isInternalUrlPath);
    const workspacePaths = input.paths.filter((path) => !isInternalUrlPath(path));
    const includes = input.paths.length > 0 && workspacePaths.length === 0 ? [] : findIncludeGlobs({ paths: workspacePaths });
    const exclude = findExcludeGlob(input);

    for (const include of includes) {
      if (Date.now() - startedAt > timeoutMs) break;
      const files = await vscode.workspace.findFiles(include, exclude, Math.max(input.limit * 5, input.limit));
      for (const uri of files) {
        try {
          const fileStat = await stat(uri);
          entries.push({ path: relativePath(uri), mtime: fileStat.mtime });
        } catch {
          entries.push({ path: relativePath(uri), mtime: 0 });
        }
      }
    }

    for (const entry of await collectMatchingDirectories(includes, input.hidden, timeoutMs, startedAt)) {
      entries.push(entry);
    }

    for (const internalPath of internalPaths) {
      const resource = await resolveInternalUrl(internalPath, ctx);
      if (!resource.sourcePath) {
        entries.push({ path: resource.url, mtime: 0 });
        continue;
      }
      try {
        const fileStat = await vscode.workspace.fs.stat(vscode.Uri.file(resource.sourcePath));
        entries.push({ path: resource.url, mtime: fileStat.mtime });
      } catch {
        entries.push({ path: resource.url, mtime: 0 });
      }
    }

    const timedOut = Date.now() - startedAt > timeoutMs;
    const merged = mergeFindEntries(entries, input.limit);
    const rendered = renderFindResults(merged.entries, {
      limited: merged.limited || timedOut,
      limit: input.limit,
      notice: timedOut ? `find timed out after ${input.timeout}s; returning partial matches` : input.gitignore ? undefined : "gitignore:false requested; Alpha uses VS Code workspace search and may still honor editor-level excludes.",
    });
    const truncated = truncateFindOutput(rendered.text, maxVisibleBytes);
    if (!truncated.truncated) return { markdown: truncated.visible };

    const artifact = ctx.artifacts.add("find output", rendered.text);
    return { markdown: `${truncated.visible}\n\n[raw output: artifact://${artifact.id}]` };
  },
};

async function collectMatchingDirectories(includes: string[], includeHidden: boolean, timeoutMs: number, startedAt: number): Promise<FindEntry[]> {
  const out: FindEntry[] = [];
  const root = workspaceRoot();

  async function visit(uri: vscode.Uri, depth: number): Promise<void> {
    if (Date.now() - startedAt > timeoutMs || depth > 25 || out.length > 2000) return;
    let children: [string, vscode.FileType][];
    try {
      children = await readDirectory(uri);
    } catch {
      return;
    }

    for (const [name, type] of children) {
      if (Date.now() - startedAt > timeoutMs) return;
      if (type !== vscode.FileType.Directory) continue;
      if (shouldSkipDirectory(name, includeHidden)) continue;
      const child = vscode.Uri.joinPath(uri, name);
      const rel = `${relativePath(child).replace(/\\/g, "/")}/`;
      if (includes.some((include) => matchesFindGlob(rel, include))) {
        let mtime = 0;
        try {
          mtime = (await stat(child)).mtime;
        } catch {
          mtime = 0;
        }
        out.push({ path: rel, mtime });
      }
      await visit(child, depth + 1);
    }
  }

  await visit(root, 0);
  return out;
}

function shouldSkipDirectory(name: string, includeHidden: boolean): boolean {
  if (["node_modules", "out", "dist", "build", ".git", "coverage", "target", "vendor"].includes(name)) return true;
  return !includeHidden && name.startsWith(".");
}
