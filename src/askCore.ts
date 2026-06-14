export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  options: AskOption[];
  multi?: boolean;
  recommended?: number;
}

export interface AskInput {
  questions: AskQuestion[];
}

export interface AskQuestionResult {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}

export const ASK_OTHER_OPTION = "Other (type your own)";
export const ASK_RECOMMENDED_SUFFIX = " (Recommended)";

export function parseAskInput(args: string): AskInput {
  const parsed = JSON.parse(args) as Partial<AskInput>;
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error("ask requires questions: [{ id, question, options }].");
  }
  return { questions: parsed.questions.map(normalizeQuestion) };
}

export function optionLabelForDisplay(option: AskOption, index: number, recommended?: number): string {
  return index === recommended && !option.label.endsWith(ASK_RECOMMENDED_SUFFIX)
    ? `${option.label}${ASK_RECOMMENDED_SUFFIX}`
    : option.label;
}

export function stripRecommendedSuffix(label: string): string {
  return label.endsWith(ASK_RECOMMENDED_SUFFIX) ? label.slice(0, -ASK_RECOMMENDED_SUFFIX.length) : label;
}

export function formatAskResult(results: AskQuestionResult[]): string {
  if (results.length === 1) {
    const [result] = results;
    const parts: string[] = [];
    if (result.selectedOptions.length > 0) {
      parts.push(result.multi ? `User selected: ${result.selectedOptions.join(", ")}` : `User selected: ${result.selectedOptions[0]}`);
    }
    if (result.customInput !== undefined) {
      parts.push(result.customInput.includes("\n")
        ? `User provided custom input:\n${result.customInput.split("\n").map((line) => `  ${line}`).join("\n")}`
        : `User provided custom input: ${result.customInput}`);
    }
    return parts.length ? parts.join("\n") : "User cancelled the selection";
  }

  return [
    "User answers:",
    ...results.map((result) => {
      const selected = result.selectedOptions.length ? result.selectedOptions.join(", ") : "(none)";
      const custom = result.customInput === undefined ? "" : `; custom: ${result.customInput}`;
      return `- ${result.id}: ${selected}${custom}`;
    }),
  ].join("\n");
}

function normalizeQuestion(raw: unknown): AskQuestion {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ask question must be an object.");
  const item = raw as Record<string, unknown>;
  const id = stringField(item, "id");
  const question = stringField(item, "question");
  const rawOptions = item.options;
  if (!Array.isArray(rawOptions)) throw new Error(`ask question ${id} requires options.`);
  const options = rawOptions.map((option, index) => normalizeOption(option, `${id}.options[${index}]`));
  const multi = typeof item.multi === "boolean" ? item.multi : undefined;
  const recommended = typeof item.recommended === "number" && Number.isInteger(item.recommended) ? item.recommended : undefined;
  if (recommended !== undefined && (recommended < 0 || recommended >= options.length)) {
    throw new Error(`ask question ${id} recommended index is out of range.`);
  }
  return {
    id,
    question,
    options,
    ...(multi === undefined ? {} : { multi }),
    ...(recommended === undefined ? {} : { recommended }),
  };
}

function normalizeOption(raw: unknown, path: string): AskOption {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must be an object.`);
  const item = raw as Record<string, unknown>;
  const label = stringField(item, "label", path);
  const description = typeof item.description === "string" && item.description.trim() ? item.description.trim() : undefined;
  return description === undefined ? { label } : { label, description };
}

function stringField(item: Record<string, unknown>, key: string, path = "question"): string {
  const value = item[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`ask ${path} requires string ${key}.`);
  return value.trim();
}
