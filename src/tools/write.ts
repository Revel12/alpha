import * as vscode from "vscode";
import { renderAnchoredFileWithTag } from "../hash";
import type { ToolDefinition } from "../types";
import { relativePath, resolveWorkspaceFile, writeText } from "../workspace";

export const writeTool: ToolDefinition = {
  name: "write",
  summary: "Write a workspace file. First line is path; remaining text is file content.",
  async run(args, ctx) {
    const [pathLine, ...body] = args.replace(/\r\n/g, "\n").split("\n");
    if (!pathLine?.trim()) throw new Error("write requires a path on the first line.");
    const uri = await resolveWorkspaceFile(pathLine.trim());
    const content = stripHashlineDisplay(body.join("\n"));
    await writeText(uri, content);
    await vscode.window.showTextDocument(uri, { preview: false });
    const path = relativePath(uri);
    const snapshot = ctx.snapshots.record(path, content);
    return { markdown: [`Wrote ${path}.`, renderAnchoredFileWithTag(path, content, snapshot.tag)].join("\n\n") };
  },
};

function stripHashlineDisplay(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (!lines[0]?.match(/^\[.+#[A-Fa-f0-9]{4}\]\s*$/)) return content;

  const withoutHeader = lines.slice(1);
  const withoutFence = withoutHeader.filter((line) => line !== "```text" && line !== "```");
  const stripped = withoutFence.map((line) => {
    const match = line.match(/^\d+:(.*)$/);
    return match ? match[1] : line;
  });
  return stripped.join("\n");
}
