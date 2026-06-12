import * as vscode from "vscode";
import { getAdvertisedAlphaLanguageModelTools, getAlphaToolRegistration } from "./toolRegistry";
import { tools } from "./tools";
import type { AlphaContext, ToolResult } from "./types";

const MAX_TOOL_ROUNDS = 8;

export function toolCallingSystemPrompt(): string {
  const toolNames = getAdvertisedAlphaLanguageModelTools().map((tool) => tool.name).join(", ");
  return [
    "You are Alpha, an OMP-style local coding harness inside VS Code.",
    "Use the provided local tools whenever workspace context, file search, file edits, diffs, or todos are needed.",
    "The available tools are private to this chat participant and intentionally mirror OMP-style names.",
    `Normally advertised tools: ${toolNames}.`,
    "Hidden tools may be exposed only for specific harness workflows.",
    "For edits, read the target file first and use the returned hash anchor in the hashline edit patch.",
    "Keep final answers concise and implementation-focused. Summarize tool results instead of dumping large outputs unless the user asks for raw output.",
  ].join("\n");
}

export async function answerWithAlphaTools(prompt: string, ctx: AlphaContext): Promise<void> {
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(toolCallingSystemPrompt()),
    vscode.LanguageModelChatMessage.User(prompt),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const activeTools = getAdvertisedAlphaLanguageModelTools();
    const activeToolNames = new Set(activeTools.map((tool) => tool.name));
    const response = await ctx.request.model.sendRequest(
      messages,
      {
        tools: activeTools,
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      },
      ctx.token,
    );

    const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        assistantParts.push(chunk);
        ctx.stream.markdown(chunk.value);
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        assistantParts.push(chunk);
        toolCalls.push(chunk);
      }
    }

    if (!toolCalls.length) return;

    if (assistantParts.length) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    }

    for (const call of toolCalls) {
      const result = await runAlphaLanguageModelTool(call, ctx, activeToolNames);
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result.markdown)]),
        ]),
      );
    }
  }

  ctx.stream.markdown("\n\nAlpha stopped after too many tool-call rounds.");
}

async function runAlphaLanguageModelTool(
  call: vscode.LanguageModelToolCallPart,
  ctx: AlphaContext,
  activeToolNames: ReadonlySet<string>,
): Promise<ToolResult> {
  if (!activeToolNames.has(call.name)) {
    return { markdown: `Alpha tool ${call.name} is not available in this workflow.` };
  }

  const registration = getAlphaToolRegistration(call.name);
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!registration || !tool) {
    return { markdown: `Unknown Alpha tool: ${call.name}` };
  }

  try {
    return await tool.run(registration.toArgs(call.input), ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { markdown: `Alpha tool ${tool.name} failed: ${message}` };
  }
}
