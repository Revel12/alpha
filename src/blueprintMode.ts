import type { AlphaContext, BlueprintModeState } from "./types";

export const DEFAULT_BLUEPRINT_FILE = "local://alpha-blueprint.md";

export type BlueprintTemplate = "default" | "concise";

export function createBlueprintModeState(initialPrompt: string, template: BlueprintTemplate = "default"): BlueprintModeState {
  const now = new Date().toISOString();
  const originalPrompt = initialPrompt.trim();
  if (!originalPrompt) throw new Error("Blueprint requires an initial request.");
  return {
    active: true,
    createdAt: now,
    updatedAt: now,
    template,
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

export function setBlueprintTemplate(state: BlueprintModeState, template: BlueprintTemplate): BlueprintModeState {
  const next = cloneBlueprintState(state);
  next.template = template;
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
    "- Blueprint mode is read-only for the workspace. Do not call mutating workspace tools. `edit` is unavailable, and `write` may only target `local://` notes.",
    "- Use `read`, `search`, `find`, `web_search`, `lsp`, `task`, `ask`, and `todo` for investigation and Q&A.",
    "- For broad, ambiguous, cross-cutting, or multi-area requests, launch parallel read-only `explore` subagents with `task` before asking final questions.",
    "- Use `task` in one OMP-style batch call when possible: `agent: \"explore\"`, shared `context`, and tasks with distinct roles such as relevant modules, existing tests, current patterns, edge cases, or integration risks.",
    "- Ask 3-5 concise questions per round when the answer would materially change the eventual plan. Prefer `ask` for structured options and recommend defaults.",
    "- Keep the refined prompt faithful to the original request and all user answers. Do not narrow the scope silently.",
    "- Do not implement code, do not submit a plan, and do not call hidden `resolve` while in Blueprint mode.",
    "- When enough information is collected, tell the user to run `/blueprint-generate` to create the Alpha plan. Do not generate the plan before that command.",
    `- Optional blueprint notes may be written to \`${state.blueprintPath}\`.`,
    "",
    "Template:",
    `- ${state.template}`,
    "",
    "Original request:",
    state.originalPrompt,
    "",
    "Current refined prompt:",
    state.refinedPrompt,
  ].join("\n");
}

export function renderBlueprintStatus(state: BlueprintModeState | undefined): string {
  if (!state) return "No active Alpha blueprint.";
  return [
    "Alpha blueprint mode is active.",
    "",
    `Template: ${state.template}`,
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
  const templateNotes = state.template === "concise"
    ? "Use a concise plan template: keep context brief, use short ordered steps, and include only essential verification."
    : "Use the default Blueprint plan template: include overview, expected behavior, ordered phases, critical files/anchors, testing/verification, and assumptions or open questions.";
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
  if (/\bconcise\b/.test(text)) return "concise";
  if (/\bdefault\b/.test(text)) return "default";
  return undefined;
}

function renderRefinedPrompt(originalPrompt: string, answers: string[]): string {
  if (!answers.length) return originalPrompt;
  return [
    originalPrompt,
    "",
    "User answers and refinements:",
    ...answers.map((answer) => `- ${answer}`),
  ].join("\n");
}

function cloneBlueprintState(state: BlueprintModeState): BlueprintModeState {
  return { ...state, rounds: state.rounds.map((round) => ({ ...round })) };
}
