import * as vscode from "vscode";
import { renderAnchoredFileWithTag } from "../hash";
import type { ToolDefinition } from "../types";
import { relativePath, resolveWorkspaceFile, stat, writeText } from "../workspace";

interface WriteInput {
  path: string;
  content: string;
  overwriteGenerated?: boolean;
  createDocumentation?: boolean;
}

export const writeTool: ToolDefinition = {
  name: "write",
  summary: "Write a workspace file. First line is path; remaining text is file content.",
  async run(args, ctx) {
    const input = parseWriteInput(args);
    const uri = await resolveWorkspaceFile(input.path);
    const path = relativePath(uri);
    await enforceWriteGuards(uri, path, input);

    const { content, stripped } = stripHashlineDisplay(input.content);
    await writeText(uri, content);
    await vscode.window.showTextDocument(uri, { preview: false });
    const snapshot = ctx.snapshots.record(path, content);
    const notes = stripped ? ["Note: auto-stripped hashline display prefixes from content before writing."] : [];
    return { markdown: [`Wrote ${path}.`, ...notes, renderAnchoredFileWithTag(path, content, snapshot.tag)].join("\n\n") };
  },
};

function parseWriteInput(args: string): WriteInput {
  const trimmed = args.trimStart();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Partial<WriteInput>;
    if (typeof parsed.path !== "string" || !parsed.path.trim()) throw new Error("write path is required.");
    if (typeof parsed.content !== "string") throw new Error("write content is required.");
    return {
      path: parsed.path,
      content: parsed.content,
      overwriteGenerated: parsed.overwriteGenerated,
      createDocumentation: parsed.createDocumentation,
    };
  }

  const [pathLine, ...body] = args.replace(/\r\n/g, "\n").split("\n");
  if (!pathLine?.trim()) throw new Error("write requires a path on the first line.");
  return { path: pathLine.trim(), content: body.join("\n") };
}

async function enforceWriteGuards(uri: vscode.Uri, path: string, input: WriteInput): Promise<void> {
  if (isDocumentationPath(path) && !(await pathExists(uri)) && input.createDocumentation !== true) {
    throw new Error(`Refusing to create documentation file ${path} without createDocumentation=true.`);
  }

  if (isGeneratedOrVendorPath(path) && input.overwriteGenerated !== true) {
    throw new Error(`Refusing to write generated/vendor artifact ${path} without overwriteGenerated=true.`);
  }
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await stat(uri);
    return true;
  } catch {
    return false;
  }
}

function isDocumentationPath(path: string): boolean {
  const basename = path.split(/[\\/]/).pop()?.toLowerCase() ?? path.toLowerCase();
  return basename === "readme" || basename.startsWith("readme.") || basename.endsWith(".md") || basename.endsWith(".mdx");
}

function isGeneratedOrVendorPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)(node_modules|dist|build|coverage|out|target|vendor)\//.test(normalized)) return true;
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|cargo\.lock|poetry\.lock)$/.test(normalized)) return true;
  if (normalized.endsWith(".min.js") || normalized.endsWith(".generated.ts") || normalized.endsWith(".generated.js")) return true;
  return false;
}

function stripHashlineDisplay(content: string): { content: string; stripped: boolean } {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (!lines[0]?.match(/^\[.+#[A-Fa-f0-9]{4}\]\s*$/)) return { content, stripped: false };

  const withoutHeader = lines.slice(1);
  const withoutFence = withoutHeader.filter((line) => line !== "```text" && line !== "```");
  const stripped = withoutFence.map((line) => {
    const match = line.match(/^\d+:(.*)$/);
    return match ? match[1] : line;
  });
  return { content: stripped.join("\n"), stripped: true };
}
