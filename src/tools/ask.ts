import * as vscode from "vscode";
import {
  ASK_OTHER_OPTION,
  formatAskResult,
  optionLabelForDisplay,
  parseAskInput,
  stripRecommendedSuffix,
  type AskQuestion,
  type AskQuestionResult,
} from "../askCore";
import type { ToolDefinition } from "../types";

export const askTool: ToolDefinition = {
  name: "ask",
  summary: "Ask the user a structured clarifying question through VS Code UI.",
  async run(args) {
    const input = parseAskInput(args);
    const results: AskQuestionResult[] = [];
    for (const question of input.questions) {
      results.push(await askQuestion(question));
    }
    return {
      markdown: formatAskResult(results),
      details: results.length === 1 ? singleDetails(results[0]) : { results },
    };
  },
};

async function askQuestion(question: AskQuestion): Promise<AskQuestionResult> {
  const displayOptions = question.options.map((option, index) => ({
    label: optionLabelForDisplay(option, index, question.recommended),
    description: option.description,
    originalLabel: option.label,
  }));
  const options = [...displayOptions, { label: ASK_OTHER_OPTION, originalLabel: ASK_OTHER_OPTION }];

  const picked = await vscode.window.showQuickPick(options, {
    title: question.question,
    placeHolder: question.question,
    canPickMany: question.multi === true,
    ignoreFocusOut: true,
  });
  if (!picked || (Array.isArray(picked) && picked.length === 0)) {
    throw new Error("Ask tool was cancelled by the user.");
  }

  const pickedItems = Array.isArray(picked) ? picked : [picked];
  const wantsOther = pickedItems.some((item) => item.originalLabel === ASK_OTHER_OPTION);
  const selectedOptions = pickedItems
    .filter((item) => item.originalLabel !== ASK_OTHER_OPTION)
    .map((item) => stripRecommendedSuffix(item.originalLabel));

  const customInput = wantsOther
    ? await vscode.window.showInputBox({
        title: question.question,
        prompt: "Enter your answer.",
        ignoreFocusOut: true,
      })
    : undefined;
  if (wantsOther && customInput === undefined) {
    throw new Error("Ask custom input was cancelled by the user.");
  }

  return {
    id: question.id,
    question: question.question,
    options: question.options.map((option) => option.label),
    multi: question.multi ?? false,
    selectedOptions,
    ...(customInput === undefined ? {} : { customInput }),
  };
}

function singleDetails(result: AskQuestionResult): object {
  return {
    question: result.question,
    options: result.options,
    multi: result.multi,
    selectedOptions: result.selectedOptions,
    ...(result.customInput === undefined ? {} : { customInput: result.customInput }),
  };
}
