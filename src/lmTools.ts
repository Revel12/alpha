import * as vscode from "vscode";
import {
  compactTranscriptWithModel,
  compactableTranscriptEntries,
  countPromptTokens,
  formatContextUsage,
  shouldAutoCompact,
  type AlphaContextUsage,
} from "./contextManager";
import { buildAlphaSystemPrompt } from "./promptBuilder";
import {
  buildModelTranscript,
  limitTranscriptHistory,
  wrapCompactionForModel,
  wrapInternalForModel,
} from "./transcript";
import { renderGoalContinuationHint } from "./goalMode";
import type { AlphaTranscriptEntry } from "./transcript";
import { getAdvertisedAlphaLanguageModelTools, runRegisteredAlphaTool } from "./toolRegistry";
import type { AlphaToolSelection } from "./toolRegistry";
import type { AlphaContext } from "./types";

const DEFAULT_MAIN_AGENT_REQUEST_BUDGET = 90;
const MAX_MAIN_AGENT_REQUEST_BUDGET = 500;
const DEFAULT_REPEATED_TOOL_BATCH_LIMIT = 6;
const DEFAULT_MID_TURN_KEEP_RECENT_TOKENS = 20000;

export function toolCallingSystemPrompt(): string {
  return buildAlphaSystemPrompt();
}

export async function answerWithAlphaTools(prompt: string, ctx: AlphaContext): Promise<void> {
  const baseSelection = getBaseToolSelection(ctx);
  let { messages, usage } = await buildInitialMessages(prompt, ctx, baseSelection, { autoCompact: true });
  const initialMessageCount = messages.length;
  if (vscode.workspace.getConfiguration("alpha").get<boolean>("context.showUsage", false)) {
    ctx.stream.markdown(`_Alpha context: ${formatContextUsage(usage)}_\n\n`);
  }
  const maxRequests = mainAgentRequestBudget();
  const repeatedBatchLimit = repeatedToolBatchLimit();
  let lastToolBatchSignature = "";
  let repeatedToolBatchCount = 0;

  for (let requestCount = 0; requestCount < maxRequests; requestCount++) {
    usage = await countPromptTokens(ctx.request.model, messages, ctx.token);
    messages = await compactInFlightMessagesIfNeeded(messages, ctx, usage, initialMessageCount);
    usage = await countPromptTokens(ctx.request.model, messages, ctx.token);
    messages = await trimMessagesToBudget(messages, ctx, usage);
    usage = await countPromptTokens(ctx.request.model, messages, ctx.token);
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
      streamGoalContinuationHint(ctx);
      return;
    }

    const batchSignature = toolBatchSignature(toolCalls);
    if (batchSignature === lastToolBatchSignature) {
      repeatedToolBatchCount += 1;
    } else {
      lastToolBatchSignature = batchSignature;
      repeatedToolBatchCount = 1;
    }
    if (repeatedToolBatchCount > repeatedBatchLimit) {
      await streamFinalNoToolResponse(
        messages,
        ctx,
        `Alpha detected the same tool-call batch ${repeatedToolBatchCount} times in a row and stopped the loop before repeating it again.`,
      );
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
      if (shouldStopAfterToolResult(result.details)) {
        ctx.stream.markdown(result.markdown);
        return;
      }
    }
  }

  await streamFinalNoToolResponse(
    messages,
    ctx,
    `Alpha reached the configured main-agent request budget (${maxRequests}).`,
  );
}

async function compactInFlightMessagesIfNeeded(
  messages: vscode.LanguageModelChatMessage[],
  ctx: AlphaContext,
  usage: AlphaContextUsage,
  initialMessageCount: number,
): Promise<vscode.LanguageModelChatMessage[]> {
  const config = vscode.workspace.getConfiguration("alpha");
  if (!config.get<boolean>("context.autoCompact", true)) return messages;
  if (!config.get<boolean>("context.midTurnAutoCompact", true)) return messages;
  if (!shouldAttemptAutoCompact(ctx, usage)) return messages;

  const keepRecentTokens = clampInteger(
    config.get<number>("context.midTurnKeepRecentTokens", DEFAULT_MID_TURN_KEEP_RECENT_TOKENS),
    1000,
    200000,
    DEFAULT_MID_TURN_KEEP_RECENT_TOKENS,
  );
  const compactStart = initialMessageCount;
  const compactEnd = await firstRecentMessageIndexForTokenBudget(messages, ctx, compactStart, keepRecentTokens);
  if (compactEnd <= compactStart) return messages;

  const compactable = messages.slice(compactStart, compactEnd);
  if (!compactable.some(hasToolRelatedContent)) return messages;

  let summary: string;
  try {
    summary = await compactInFlightWithModel(compactable, ctx, usage.inputTokens);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stream.markdown(`_Alpha in-flight compaction skipped: ${message}_\n\n`);
    return messages;
  }
  const compactedMessage = vscode.LanguageModelChatMessage.User(
    wrapInternalForModel(summary, "compaction"),
    "alpha_internal",
  );
  const next = [
    ...messages.slice(0, compactStart),
    compactedMessage,
    ...messages.slice(compactEnd),
  ];
  const nextUsage = await countPromptTokens(ctx.request.model, next, ctx.token);
  ctx.stream.markdown(`_Alpha compacted in-flight tool context: ${usage.inputTokens.toLocaleString()} -> ${nextUsage.inputTokens.toLocaleString()} input tokens._\n\n`);
  return next;
}

async function firstRecentMessageIndexForTokenBudget(
  messages: readonly vscode.LanguageModelChatMessage[],
  ctx: AlphaContext,
  minIndex: number,
  tokenBudget: number,
): Promise<number> {
  let keptTokens = 0;
  for (let index = messages.length - 1; index >= minIndex; index--) {
    const messageTokens = await ctx.request.model.countTokens(messages[index], ctx.token);
    if (keptTokens > 0 && keptTokens + messageTokens > tokenBudget) return index + 1;
    keptTokens += messageTokens;
  }
  return minIndex;
}

async function compactInFlightWithModel(
  messages: vscode.LanguageModelChatMessage[],
  ctx: AlphaContext,
  tokensBefore: number,
): Promise<string> {
  const rendered = renderLanguageModelMessagesForCompaction(messages);
  const boundedRendered = rendered.length > 180000
    ? `${rendered.slice(0, 90000)}\n\n...[middle omitted from in-flight compaction input]...\n\n${rendered.slice(-90000)}`
    : rendered;
  const prompt = [
    "Create an Alpha in-flight compaction summary for a coding-agent tool loop.",
    "The summarized messages are completed assistant/tool-result exchanges from the current turn.",
    "Preserve concrete facts, files changed or inspected, command outputs, diagnostics, pending decisions, failed attempts, and the next action implied by the work.",
    "Do not invent completed work. Do not include generic filler. Keep identifiers, paths, errors, and user-visible outcomes exact.",
    `Tokens before compaction: ${tokensBefore}`,
    "",
    "Completed in-flight messages to summarize:",
    boundedRendered,
  ].join("\n");

  const response = await ctx.request.model.sendRequest([
    vscode.LanguageModelChatMessage.User(wrapInternalForModel(prompt, "compaction"), "alpha_internal"),
  ], {}, ctx.token);

  const chunks: string[] = [];
  for await (const chunk of response.stream) {
    if (chunk instanceof vscode.LanguageModelTextPart) chunks.push(chunk.value);
  }
  const summary = chunks.join("").trim();
  if (!summary) throw new Error("In-flight compaction returned an empty summary.");
  return [
    "Alpha in-flight tool-loop compaction summary. This summary replaces older completed tool exchanges from the current turn.",
    "",
    summary,
  ].join("\n");
}

export function renderLanguageModelMessagesForCompaction(messages: readonly vscode.LanguageModelChatMessage[]): string {
  return messages.map((message, index) => {
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
    const name = message.name ? ` name=${message.name}` : "";
    return [`## ${index + 1}. ${role}${name}`, renderMessageParts(message.content)].join("\n");
  }).join("\n\n");
}

function renderMessageParts(parts: readonly (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelToolCallPart)[]): string {
  return parts.map((part) => {
    if (part instanceof vscode.LanguageModelTextPart) return part.value;
    if (part instanceof vscode.LanguageModelToolCallPart) {
      return [
        `<tool_call name="${part.name}" callId="${part.callId}">`,
        stableStringify(part.input),
        "</tool_call>",
      ].join("\n");
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
      return [
        `<tool_result callId="${part.callId}">`,
        renderToolResultContent(part.content),
        "</tool_result>",
      ].join("\n");
    }
    return String(part);
  }).join("\n");
}

function renderToolResultContent(parts: readonly unknown[]): string {
  return parts.map((part) => {
    if (part instanceof vscode.LanguageModelTextPart) return part.value;
    if (typeof part === "string") return part;
    return stableStringify(part);
  }).join("\n");
}

function hasToolRelatedContent(message: vscode.LanguageModelChatMessage): boolean {
  return message.content.some((part) => part instanceof vscode.LanguageModelToolCallPart || part instanceof vscode.LanguageModelToolResultPart);
}

function shouldStopAfterToolResult(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  return (details as { stopAfterToolResult?: unknown }).stopAfterToolResult === true;
}

async function streamFinalNoToolResponse(
  messages: vscode.LanguageModelChatMessage[],
  ctx: AlphaContext,
  reason: string,
): Promise<void> {
  const finalMessages = [
    ...messages,
    vscode.LanguageModelChatMessage.User(
      wrapInternalForModel(
        [
          reason,
          "Do not call tools. Give the user the best concise final answer from the work already completed.",
          "If the task is incomplete, say exactly what remains and what prompt would continue it.",
        ].join("\n"),
        "alpha-system",
      ),
      "alpha_internal",
    ),
  ];

  try {
    const response = await ctx.request.model.sendRequest(finalMessages, {}, ctx.token);
    let emitted = false;
    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        emitted = true;
        ctx.stream.markdown(chunk.value);
      }
    }
    if (!emitted) {
      ctx.stream.markdown(`${reason} No final model text was returned.`);
    }
    streamGoalContinuationHint(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stream.markdown(`${reason} Final no-tool response failed: ${message}`);
  }
}

function streamGoalContinuationHint(ctx: AlphaContext): void {
  if (!vscode.workspace.getConfiguration("alpha").get<boolean>("goal.continuationHint", true)) return;
  const hint = renderGoalContinuationHint(ctx.goalMode);
  if (hint) ctx.stream.markdown(hint);
}

function mainAgentRequestBudget(): number {
  const configured = vscode.workspace.getConfiguration("alpha").get<number>("tools.maxRequests", DEFAULT_MAIN_AGENT_REQUEST_BUDGET);
  return clampInteger(configured, 1, MAX_MAIN_AGENT_REQUEST_BUDGET, DEFAULT_MAIN_AGENT_REQUEST_BUDGET);
}

function repeatedToolBatchLimit(): number {
  const configured = vscode.workspace.getConfiguration("alpha").get<number>("tools.maxRepeatedToolBatches", DEFAULT_REPEATED_TOOL_BATCH_LIMIT);
  return clampInteger(configured, 1, 50, DEFAULT_REPEATED_TOOL_BATCH_LIMIT);
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function toolBatchSignature(toolCalls: vscode.LanguageModelToolCallPart[]): string {
  return toolCalls.map((call) => `${call.name}:${stableStringify(call.input)}`).join("\n");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

export async function alphaContextUsageForPrompt(prompt: string, ctx: AlphaContext): Promise<AlphaContextUsage> {
  return (await buildInitialMessages(prompt, ctx, getBaseToolSelection(ctx), { autoCompact: false })).usage;
}

async function buildInitialMessages(
  prompt: string,
  ctx: AlphaContext,
  baseSelection: AlphaToolSelection,
  opts: { autoCompact: boolean },
): Promise<{ messages: vscode.LanguageModelChatMessage[]; usage: AlphaContextUsage }> {
  const maxHistoryTurns = vscode.workspace.getConfiguration("alpha").get<number>("session.maxHistoryTurns", 30);
  const boundedMaxHistoryTurns = Math.max(0, maxHistoryTurns);
  let historyTranscript = boundedMaxHistoryTurns <= 0
    ? ctx.transcript.filter((entry) => entry.historyIndex === undefined)
    : limitTranscriptHistory(ctx.transcript, boundedMaxHistoryTurns, ctx.chatContext.history.length);
  const omitted = Math.max(0, ctx.chatContext.history.length - boundedMaxHistoryTurns);
  let messages = buildLanguageModelMessages(prompt, ctx, baseSelection, historyTranscript, omitted);
  let usage = await countPromptTokens(ctx.request.model, messages, ctx.token);

  if (opts.autoCompact && shouldAttemptAutoCompact(ctx, usage)) {
    const compactable = compactableTranscriptEntries(historyTranscript);
    const lastHistoryIndex = compactable.at(-1)?.historyIndex;
    if (lastHistoryIndex !== undefined) {
      const result = await compactTranscriptWithModel({
        model: ctx.request.model,
        token: ctx.token,
        sessionLabel: ctx.sessionLabel,
        sessionKey: ctx.sessionKey,
        transcript: compactable,
        existingSummary: ctx.compactionSummary,
        throughHistoryIndex: lastHistoryIndex,
        tokensBefore: usage.inputTokens,
      });
      ctx.compactionSummary = result.summary;
      ctx.compactedThroughHistoryIndex = result.compactedThroughHistoryIndex;
      ctx.setCompaction?.(result.summary, result.compactedThroughHistoryIndex);
      historyTranscript = ctx.transcript.filter((entry) => entry.historyIndex === undefined || entry.historyIndex > result.compactedThroughHistoryIndex);
      messages = buildLanguageModelMessages(prompt, ctx, baseSelection, historyTranscript, omitted);
      usage = await countPromptTokens(ctx.request.model, messages, ctx.token);
      ctx.stream.markdown(`_Alpha compacted context: ${result.tokensBefore.toLocaleString()} -> ${usage.inputTokens.toLocaleString()} input tokens._\n\n`);
    }
  }

  messages = await trimMessagesToBudget(messages, ctx, usage);
  usage = await countPromptTokens(ctx.request.model, messages, ctx.token);
  return { messages, usage };
}

function buildLanguageModelMessages(
  prompt: string,
  ctx: AlphaContext,
  baseSelection: AlphaToolSelection,
  historyTranscript: readonly AlphaTranscriptEntry[],
  omitted: number,
): vscode.LanguageModelChatMessage[] {
  const modelTranscript = buildModelTranscript({
    internalPrompt: buildAlphaSystemPrompt(ctx, baseSelection),
    historyTranscript,
    currentPrompt: prompt,
    omittedHistoryTurns: omitted,
  });
  return modelTranscript.map(transcriptEntryToLanguageModelMessage);
}

function shouldAttemptAutoCompact(ctx: AlphaContext, usage: AlphaContextUsage): boolean {
  const config = vscode.workspace.getConfiguration("alpha");
  if (!config.get<boolean>("context.autoCompact", true)) return false;
  const thresholdPercent = config.get<number>("context.compactionThresholdPercent", 80);
  const thresholdTokens = config.get<number>("context.compactionThresholdTokens", -1);
  return shouldAutoCompact(usage, thresholdPercent, thresholdTokens);
}

async function trimMessagesToBudget(
  messages: vscode.LanguageModelChatMessage[],
  ctx: AlphaContext,
  usage: AlphaContextUsage,
): Promise<vscode.LanguageModelChatMessage[]> {
  const targetPercent = vscode.workspace.getConfiguration("alpha").get<number>("context.targetPercent", 90);
  const targetTokens = Math.floor(usage.maxInputTokens * Math.max(10, Math.min(100, targetPercent)) / 100);
  let next = [...messages];
  let currentUsage = usage;
  while (currentUsage.inputTokens > targetTokens && next.length > 2) {
    const dropIndex = next.findIndex((message, index) => index > 0 && index < next.length - 1 && !hasToolRelatedContent(message));
    if (dropIndex < 0) break;
    next.splice(dropIndex, 1);
    currentUsage = await countPromptTokens(ctx.request.model, next, ctx.token);
  }
  return next;
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
  const forcedModeTools = [
    ...(ctx.planMode?.active ? ["resolve"] : []),
    ...(ctx.goalMode ? ["goal"] : []),
  ];
  if (discoveryMode === "all") {
    return {
      ctx,
      includeDiscoverable: false,
      forceTools: [...forcedModeTools, "search_tool_bm25", ...ctx.discoveredTools.list()],
    };
  }
  return {
    ctx,
    includeDiscoverable: true,
    forceTools: forcedModeTools.length ? forcedModeTools : undefined,
  };
}
