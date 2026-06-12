import * as vscode from "vscode";
import { buildAlphaSystemPrompt } from "./promptBuilder";
import { getAdvertisedAlphaLanguageModelTools, runRegisteredAlphaTool } from "./toolRegistry";
import type { AlphaToolSelection } from "./toolRegistry";
import type { AlphaContext } from "./types";

const MAX_TOOL_ROUNDS = 8;

export function toolCallingSystemPrompt(): string {
  return buildAlphaSystemPrompt();
}

export async function answerWithAlphaTools(prompt: string, ctx: AlphaContext): Promise<void> {
  const baseSelection = getBaseToolSelection(ctx);
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(buildAlphaSystemPrompt(ctx, baseSelection)),
    vscode.LanguageModelChatMessage.User(prompt),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const pendingResolve = ctx.pendingEdits.list().length > 0;
    const selection = pendingResolve ? { ctx, forceTools: ["resolve"], onlyForced: true } : { ...baseSelection, ctx };
    const activeTools = getAdvertisedAlphaLanguageModelTools(
      selection,
    );
    const activeToolNames = new Set(activeTools.map((tool) => tool.name));
    const response = await ctx.request.model.sendRequest(
      messages,
      {
        tools: activeTools,
        toolMode: pendingResolve ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto,
      },
      ctx.token,
    );

    const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
    const bufferedText: string[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        assistantParts.push(chunk);
        bufferedText.push(chunk.value);
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        assistantParts.push(chunk);
        toolCalls.push(chunk);
      }
    }

    if (!toolCalls.length) {
      ctx.stream.markdown(bufferedText.join(""));
      return;
    }

    if (assistantParts.length) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    }

    for (const call of toolCalls) {
      const result = await runRegisteredAlphaTool(call.name, call.input, ctx, activeToolNames);
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result.markdown)]),
        ]),
      );
    }
  }

  ctx.stream.markdown("\n\nAlpha stopped after too many tool-call rounds.");
}

function getBaseToolSelection(ctx: AlphaContext): AlphaToolSelection {
  const discoveryMode = vscode.workspace.getConfiguration("alpha").get<"off" | "all">("tools.discoveryMode", "off");
  return {
    ctx,
    includeDiscoverable: discoveryMode !== "all",
  };
}
