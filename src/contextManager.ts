import * as vscode from "vscode";
import { renderTranscriptMarkdown, wrapInternalForModel, type AlphaTranscriptEntry } from "./transcript";

export interface AlphaContextUsage {
  inputTokens: number;
  maxInputTokens: number;
  percent: number;
}

export interface AlphaCompactionResult {
  summary: string;
  compactedThroughHistoryIndex: number;
  tokensBefore: number;
}

export async function countPromptTokens(
  model: vscode.LanguageModelChat,
  messages: readonly vscode.LanguageModelChatMessage[],
  token?: vscode.CancellationToken,
): Promise<AlphaContextUsage> {
  let inputTokens = 0;
  for (const message of messages) {
    inputTokens += await model.countTokens(message, token);
  }
  const maxInputTokens = Math.max(1, model.maxInputTokens || 1);
  return {
    inputTokens,
    maxInputTokens,
    percent: inputTokens / maxInputTokens,
  };
}

export function shouldAutoCompact(usage: AlphaContextUsage, thresholdPercent: number, thresholdTokens: number): boolean {
  if (thresholdTokens > 0) return usage.inputTokens >= thresholdTokens;
  return usage.percent >= thresholdPercent / 100;
}

export function formatContextUsage(usage: AlphaContextUsage): string {
  const percent = (usage.percent * 100).toFixed(1);
  return `${usage.inputTokens.toLocaleString()} / ${usage.maxInputTokens.toLocaleString()} input tokens (${percent}%)`;
}

export async function compactTranscriptWithModel(input: {
  model: vscode.LanguageModelChat;
  token: vscode.CancellationToken;
  sessionLabel: string;
  sessionKey: string;
  transcript: readonly AlphaTranscriptEntry[];
  existingSummary?: string;
  throughHistoryIndex: number;
  tokensBefore: number;
}): Promise<AlphaCompactionResult> {
  const transcript = renderTranscriptMarkdown({
    title: input.sessionLabel,
    sessionKey: input.sessionKey,
    transcript: input.transcript,
  });
  const boundedTranscript = transcript.length > 180000
    ? `${transcript.slice(0, 90000)}\n\n...[middle omitted for compaction input]...\n\n${transcript.slice(-90000)}`
    : transcript;
  const prompt = [
    "Create an Alpha compaction summary for a coding-agent session.",
    "Preserve user goals, decisions, constraints, repository facts, files touched, tool outputs that matter, pending work, open questions, and explicit non-goals.",
    "Do not include generic filler. Do not claim work was completed unless the transcript shows it.",
    input.existingSummary ? `\nExisting summary to merge:\n${input.existingSummary}` : "",
    "\nTranscript to compact:",
    boundedTranscript,
  ].join("\n");

  const response = await input.model.sendRequest([
    vscode.LanguageModelChatMessage.User(wrapInternalForModel(prompt, "compaction"), "alpha_internal"),
  ], {}, input.token);

  const chunks: string[] = [];
  for await (const chunk of response.stream) {
    if (chunk instanceof vscode.LanguageModelTextPart) chunks.push(chunk.value);
  }
  const summary = chunks.join("").trim();
  if (!summary) throw new Error("Compaction returned an empty summary.");
  return {
    summary,
    compactedThroughHistoryIndex: input.throughHistoryIndex,
    tokensBefore: input.tokensBefore,
  };
}

export function compactableTranscriptEntries(transcript: readonly AlphaTranscriptEntry[]): AlphaTranscriptEntry[] {
  return transcript.filter((entry) => entry.historyIndex !== undefined);
}
