import type { AlphaContext, BlueprintModeState } from "./types";

export const DEFAULT_BLUEPRINT_FILE = "local://alpha-blueprint.md";

export type BlueprintTemplate = "default" | "concise" | "custom";

export interface BlueprintTemplateSelection {
  template: BlueprintTemplate;
  customTemplatePrompt?: string;
}

const DEFAULT_TEMPLATE_DESCRIPTION = "Overview, Expected behavior, Implementation plan, Implementation phases, Testing strategy, Open questions";
const CONCISE_TEMPLATE_DESCRIPTION = "Overview, Expected behavior, Changes";

const DEFAULT_TEMPLATE_PROMPT = [
  "The plan should contain EXACTLY the following sections in order.",
  "Use bullet points with short, readable sentences throughout. The plan should be glanceable; no long paragraphs.",
  "",
  "- Overview: The key decisions and motivation for the changes",
  "- Expected behavior: The resulting behavior from the user's or system's perspective, including any changes in behavior due to interaction of new and existing functionality, as bullet points",
  "- Implementation plan: The full list of files, classes, methods, functions, data types, etc. to create or modify and what they will do",
  "- Implementation phases: Ordered phases, where each phase builds on the previous and results in a working (but potentially incomplete) system",
  "- Testing strategy: How to test the changes, including unit tests, integration tests, and edge cases",
  "- Open questions: Unresolved design decisions, trade-offs, or ambiguities that need further discussion",
].join("\n");

const CONCISE_TEMPLATE_PROMPT = [
  "Write a concise plan with three sections.",
  "Use bullet points with short, readable sentences throughout. The plan should be glanceable; no long paragraphs.",
  "",
  "- Overview (4-5 bullet points): The key decisions and motivation for the changes",
  "- Expected behavior: The resulting behavior from the user's or system's perspective, including any changes in behavior due to interaction of new and existing functionality, as bullet points",
  "- Changes: What needs to change relative to the existing system, as bullet points without implementation details",
].join("\n");

export function createBlueprintModeState(initialPrompt: string, template?: BlueprintTemplate, customTemplatePrompt?: string): BlueprintModeState {
  const now = new Date().toISOString();
  const originalPrompt = initialPrompt.trim();
  if (!originalPrompt) throw new Error("Blueprint requires an initial request.");
  return {
    active: true,
    createdAt: now,
    updatedAt: now,
    template: template ?? "default",
    templateSelected: template !== undefined,
    customTemplatePrompt: template === "custom" ? customTemplatePrompt?.trim() : undefined,
    blueprintPath: DEFAULT_BLUEPRINT_FILE,
    originalPrompt,
    refinedPrompt: originalPrompt,
    rounds: [],
  };
}

export function isBlueprintModeActive(ctx: Pick<AlphaContext, "blueprintMode"> | undefined): boolean {
  return ctx?.blueprintMode?.active === true;
}

export function assertBlueprintWriteAllowed(path: string, ctx: Pick<AlphaContext, "blueprintMode">): void {
  if (!isBlueprintModeActive(ctx)) return;
  if (path.trim().toLowerCase().startsWith("local://")) return;
  throw new Error(
    "Blueprint mode keeps the workspace read-only. Write blueprint notes to local:// only, then run /blueprint-generate when ready.",
  );
}

export function appendBlueprintAnswer(state: BlueprintModeState, answer: string): BlueprintModeState {
  const trimmed = answer.trim();
  if (!trimmed) return state;
  const next = cloneBlueprintState(state);
  next.rounds.push({ answer: trimmed, createdAt: new Date().toISOString() });
  next.refinedPrompt = renderRefinedPrompt(next.originalPrompt, next.rounds.map((round) => round.answer));
  next.updatedAt = new Date().toISOString();
  return next;
}

export function setBlueprintTemplate(state: BlueprintModeState, template: BlueprintTemplate, customTemplatePrompt?: string): BlueprintModeState {
  const next = cloneBlueprintState(state);
  next.template = template;
  next.templateSelected = true;
  next.customTemplatePrompt = template === "custom" ? customTemplatePrompt?.trim() : undefined;
  next.updatedAt = new Date().toISOString();
  return next;
}

export function deactivateBlueprintMode(state: BlueprintModeState): BlueprintModeState {
  const next = cloneBlueprintState(state);
  next.active = false;
  next.updatedAt = new Date().toISOString();
  return next;
}

export function blueprintModeSystemPrompt(ctx: AlphaContext): string | undefined {
  const state = ctx.blueprintMode;
  if (!state?.active) return undefined;
  return [
    "# Blueprint Mode",
    "- You are in Blueprint mode: shape an ambiguous request into a high-quality implementation spec before Alpha plan mode.",
    state.templateSelected
      ? "- A plan template has been selected; continue codebase exploration and Q&A."
      : "- Template selection is pending. Do not explore or ask feature questions until the user selects a template.",
    "- Blueprint mode is read-only for the workspace. Do not call mutating workspace tools. `edit` is unavailable, and `write` may only target `local://` notes.",
    "- Use `read`, `search`, `find`, `web_search`, `lsp`, `task`, and `todo` for investigation. Do not use popup/UI question tools.",
    "- For broad, ambiguous, cross-cutting, or multi-area requests, launch parallel read-only `explore` subagents with `task` before asking final questions.",
    "- Use `task` in one OMP-style batch call when possible: `agent: \"explore\"`, shared `context`, and tasks with distinct roles such as relevant modules, existing tests, current patterns, edge cases, or integration risks.",
    "- Ask 3-5 concise questions per round inline in chat.",
    "- Before every question round, include this hint: `> Answer with shorthand like `1a, 2b, 3e, 4a, 5b` or write freely.`",
    "- Use Blueprint-style question formatting: `**Q1. Question text**`, then `_Context: one or two brief lines grounded in the current plan/codebase_`, then lettered choices.",
    "- Leave two blank lines between questions. Leave a blank line between the question text, context line, and options.",
    "- For questions with clear choices, provide short lettered options and always include a final `Other (describe)` option. Use open-ended questions only when lettered choices would be misleading.",
    "- Focus on decisions that meaningfully affect the implementation, not trivial or obvious choices.",
    "- Questions must match the level and perspective of the selected template. If the template asks about external behavior, ask about external behavior; if it asks about implementation details, ask about implementation details.",
    "- Users generally expect to continue existing patterns and expand their system. Only question existing patterns when the requested change clearly conflicts with them.",
    "- Do not ask about implementation details unless the selected template explicitly calls for them.",
    "- Keep context between questions brief; do not include a full analysis dump.",
    "- After the user answers, acknowledge briefly, show the updated refined prompt in a blockquote, then ask 3-5 more questions.",
    "- Do not repeat questions whose answers are already captured in the refined prompt or prior chat. Do not ask about choices already settled by the user answer.",
    "- The next questions may be follow-ups to the user's answers or additional new/ambiguous topics that still need to be discussed.",
    "- Keep asking rounds of follow-up questions until the user runs `/blueprint-generate`. Do not stop asking questions on your own.",
    "- Refined prompt rules: keep the original request wording exactly, add only `*` bullet points for clarifications, insert new bullet points in logical locations near related content, and add one concise bullet per question-answer pair.",
    "- Keep the refined prompt faithful to the original request and all user answers. Do not narrow the scope silently.",
    "- Do not implement code, do not submit a plan, and do not call hidden `resolve` while in Blueprint mode.",
    "- After each question round, remind the user to run `/blueprint-generate` when they are ready to end Q&A and create the Alpha plan. Do not generate the plan before that command.",
    `- Optional blueprint notes may be written to \`${state.blueprintPath}\`.`,
    "",
    "Template:",
    `- ${renderTemplateLabel(state)}`,
    state.customTemplatePrompt ? `- custom instructions: ${state.customTemplatePrompt}` : undefined,
    state.templateSelected ? ["", "Template prompt:", templateInstructions(state)].join("\n") : undefined,
    "",
    "Original request:",
    state.originalPrompt,
    "",
    "Current refined prompt:",
    state.refinedPrompt,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function renderBlueprintStatus(state: BlueprintModeState | undefined): string {
  if (!state) return "No active Alpha blueprint.";
  return [
    "Alpha blueprint mode is active.",
    "",
    `Template: ${renderTemplateLabel(state)}`,
    `Blueprint notes: \`${state.blueprintPath}\``,
    `Answer rounds: ${state.rounds.length}`,
    "",
    "Current refined prompt:",
    state.refinedPrompt,
    "",
    "Reply with answers or new constraints, or run `/blueprint-generate` to create an Alpha plan.",
  ].join("\n");
}

export function buildBlueprintGeneratePrompt(state: BlueprintModeState): string {
  const templateNotes = templateInstructions(state);
  return [
    "Generate an Alpha execution plan from this Blueprint.",
    templateNotes,
    "Write the plan to the active Alpha plan file, then submit it for review with the hidden resolve apply action. Do not implement in this turn.",
    "",
    "Original request:",
    state.originalPrompt,
    "",
    "Refined prompt:",
    state.refinedPrompt,
  ].join("\n");
}

export function isBlueprintGeneratePrompt(prompt: string): boolean {
  return /\b(generate|create|write|make)\b.*\b(plan|blueprint)\b/i.test(prompt)
    || /\b(done|ready)\b.*\b(plan|generate)\b/i.test(prompt);
}

export function parseBlueprintTemplate(input: string): BlueprintTemplate | undefined {
  const text = input.toLowerCase();
  if (/\b(custom|other)\b/.test(text)) return "custom";
  if (/\bconcise\b/.test(text)) return "concise";
  if (/\bdefault\b/.test(text)) return "default";
  return undefined;
}

export function parseBlueprintTemplateSelection(input: string): BlueprintTemplateSelection | undefined {
  const trimmed = input.trim();
  const text = trimmed.toLowerCase();
  if (!trimmed) return undefined;
  if (/^(?:1)?a(?:\b|[\s,.)-])/.test(text) || /\bdefault\b/.test(text)) {
    return { template: "default" };
  }
  if (/^(?:1)?b(?:\b|[\s,.)-])/.test(text) || /\bconcise\b/.test(text)) {
    return { template: "concise" };
  }
  const customMatch = /^(?:(?:1)?c|other|custom)(?:\b|[\s,.)-])\s*(?:[:,-]\s*)?([\s\S]*)$/i.exec(trimmed);
  if (customMatch) {
    const customTemplatePrompt = customMatch[1]?.trim();
    return { template: "custom", customTemplatePrompt };
  }
  return undefined;
}

export function renderBlueprintTemplateQuestion(state: BlueprintModeState, note?: string): string {
  return [
    note,
    "Choose a Blueprint plan template before I explore the codebase.",
    "",
    "> Answer with `1a`, `1b`, or `1c: <custom template>`.",
    "",
    "**Q1. Which plan template should this Blueprint use?**",
    "_Context: The template controls the shape and level of detail of the final plan._",
    "",
    `a) Default: ${DEFAULT_TEMPLATE_DESCRIPTION}`,
    `b) Concise: ${CONCISE_TEMPLATE_DESCRIPTION}`,
    "c) Other (describe): provide a custom plan structure or level of detail",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderRefinedPrompt(originalPrompt: string, answers: string[]): string {
  if (!answers.length) return originalPrompt;
  return [
    originalPrompt,
    "",
    ...answers.map((answer) => `* ${answer}`),
  ].join("\n");
}

function cloneBlueprintState(state: BlueprintModeState): BlueprintModeState {
  return { ...state, rounds: state.rounds.map((round) => ({ ...round })) };
}

function renderTemplateLabel(state: BlueprintModeState): string {
  if (!state.templateSelected) return "pending selection";
  if (state.template === "custom") return "custom";
  return state.template;
}

function templateInstructions(state: BlueprintModeState): string {
  if (state.template === "concise") {
    return CONCISE_TEMPLATE_PROMPT;
  }
  if (state.template === "custom") {
    return `Use this custom Blueprint template or plan guidance: ${state.customTemplatePrompt || "the user's custom template selection from the Q&A."}`;
  }
  return DEFAULT_TEMPLATE_PROMPT;
}
