import * as vscode from "vscode";
import { wrapInternalForModel } from "../transcript";
import type { ToolDefinition } from "../types";

export const reviewTool: ToolDefinition = {
  name: "review",
  summary: "Ask the selected Copilot model to review provided text. Uses VS Code request.model; no auth handling.",
  async run(args, ctx) {
    const input = args.trim();
    if (!input) throw new Error("review requires text, a diff, or file content.");

    const messages = [
      vscode.LanguageModelChatMessage.User(
        wrapInternalForModel(
          "You are Alpha, an OMP-style code review helper. Return concise findings with file/line references when possible. Do not produce patches unless asked.",
          "alpha-system",
        ),
        "alpha_internal",
      ),
      vscode.LanguageModelChatMessage.User(input, "user"),
    ];
    const response = await ctx.request.model.sendRequest(messages, {}, ctx.token);
    let markdown = "";
    for await (const chunk of response.text) {
      markdown += chunk;
    }
    return { markdown: markdown.trim() || "No review output." };
  },
};
