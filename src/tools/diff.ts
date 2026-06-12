import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "../types";
import { workspaceRoot } from "../workspace";

const execFileAsync = promisify(execFile);

export const diffTool: ToolDefinition = {
  name: "diff",
  summary: "Show changed files and diff stats from git.",
  async run() {
    const cwd = workspaceRoot().fsPath;
    try {
      const [status, stat] = await Promise.all([
        execFileAsync("git", ["status", "--short"], { cwd }),
        execFileAsync("git", ["diff", "--stat"], { cwd }),
      ]);
      const statusText = status.stdout.trim();
      const statText = stat.stdout.trim();
      if (!statusText && !statText) return { markdown: "No git changes found." };
      return {
        markdown: [`## Status`, "```text", statusText || "(clean)", "```", "## Diff Stat", "```text", statText || "(none)", "```"].join("\n"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`git diff failed: ${message}`);
    }
  },
};
