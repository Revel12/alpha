import * as vscode from "vscode";
import { buildAlphaSystemPrompt } from "./promptBuilder";
import {
  buildModelTranscript,
  limitTranscriptHistory,
  wrapCompactionForModel,
  wrapInternalForModel,
} from "./transcript";
import type { AlphaTranscriptEntry } from "./transcript";
import { getAdvertisedAlphaLanguageModelTools, runRegisteredAlphaTool } from "./toolRegistry";
import type { AlphaToolSelection } from "./toolRegistry";
import type { AlphaContext } from "./types";

const MAX_TOOL_ROUNDS = 8;

export function toolCallingSystemPrompt(): string {
  return buildAlphaSystemPrompt();
}

export async function answerWithAlphaTools(prompt: string, ctx: AlphaContext): Promise<void> {
  const baseSelection = getBaseToolSelection(ctx);
  const messages = buildInitialMessages(prompt, ctx, baseSelection);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const pendingResolve = ctx.pendingEdits.list().length > 0;
    const selection = pendingResolve ? { ctx, forceTools: ["resolve"], onlyForced: true } : getBaseToolSelection(ctx);
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

function buildInitialMessages(prompt: string, ctx: AlphaContext, baseSelection: AlphaToolSelection): vscode.LanguageModelChatMessage[] {
  const maxHistoryTurns = vscode.workspace.getConfiguration("alpha").get<number>("session.maxHistoryTurns", 30);
  const boundedMaxHistoryTurns = Math.max(0, maxHistoryTurns);
  const historyTranscript = boundedMaxHistoryTurns <= 0
    ? ctx.transcript.filter((entry) => entry.historyIndex === undefined)
    : limitTranscriptHistory(ctx.transcript, boundedMaxHistoryTurns, ctx.chatContext.history.length);
  const omitted = Math.max(0, ctx.chatContext.history.length - boundedMaxHistoryTurns);
  const modelTranscript = buildModelTranscript({
    internalPrompt: buildAlphaSystemPrompt(ctx, baseSelection),
    historyTranscript,
    currentPrompt: prompt,
    omittedHistoryTurns: omitted,
  });
  return modelTranscript.map(transcriptEntryToLanguageModelMessage);
}

function transcriptEntryToLanguageModelMessage(entry: AlphaTranscriptEntry): vscode.LanguageModelChatMessage {
  if (entry.role === "assistant") {
    return vscode.LanguageModelChatMessage.Assistant(entry.content);
  }
  if (entry.role === "internal") {
    return vscode.LanguageModelChatMessage.User(wrapInternalForModel(entry.content, entry.source), "alpha_internal");
  }
  if (entry.role === "compaction") {
    return vscode.LanguageModelChatMessage.User(wrapCompactionForModel(entry.content), "alpha_internal");
  }
  return vscode.LanguageModelChatMessage.User(entry.content, "user");
}

function getBaseToolSelection(ctx: AlphaContext): AlphaToolSelection {
  const discoveryMode = vscode.workspace.getConfiguration("alpha").get<"off" | "all">("tools.discoveryMode", "off");
  if (discoveryMode === "all") {
    return {
      ctx,
      includeDiscoverable: false,
      forceTools: ["search_tool_bm25", ...ctx.discoveredTools.list()],
    };
  }
  return {
    ctx,
    includeDiscoverable: true,
  };
}
