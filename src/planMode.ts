import type { AlphaContext, PlanModeState } from "./types";

export const DEFAULT_PLAN_FILE = "local://alpha-plan.md";

export function createPlanModeState(initialPrompt?: string): PlanModeState {
  return {
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    planPath: DEFAULT_PLAN_FILE,
    initialPrompt,
  };
}

export function isPlanApprovalAsGoalPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (!/\bgoal\b/.test(text)) return false;
  return /\b(approve|approved|apply|implement|execute|proceed|go ahead|start)\b/.test(text);
}

export function buildPlanGoalObjective(plan: string, planPath: string, userApprovalMessage?: string): string {
  const parts = [
    `Implement the approved Alpha plan at ${planPath}.`,
    "",
    "Approved plan:",
    plan.trim(),
  ];
  const trimmedMessage = userApprovalMessage?.trim();
  if (trimmedMessage) {
    parts.push("", "User approval message:", trimmedMessage);
  }
  return parts.join("\n");
}

export function updatePlanMode(state: PlanModeState, patch: Partial<PlanModeState>): PlanModeState {
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });
  return state;
}

export function isPlanModeActive(ctx: Pick<AlphaContext, "planMode"> | undefined): boolean {
  return ctx?.planMode?.active === true;
}

export function assertPlanModeWriteAllowed(path: string, ctx: Pick<AlphaContext, "planMode">): void {
  if (!isPlanModeActive(ctx)) return;
  if (path.trim().toLowerCase().startsWith("local://")) return;
  throw new Error(
    "Plan mode keeps the workspace read-only. Write the draft plan or scratch notes to local://, then call resolve with action apply when the plan is ready.",
  );
}

export function planModeSystemPrompt(ctx: AlphaContext): string | undefined {
  if (!isPlanModeActive(ctx)) return undefined;
  const planPath = ctx.planMode?.planPath ?? DEFAULT_PLAN_FILE;
  const approvedPlan = ctx.planMode?.approvedPlan;
  const pendingApproval = ctx.planMode?.pendingApproval;
  const lines = [
    "# Plan Mode",
    "- You are in OMP-style plan mode. Explore and plan before implementation.",
    "- The workspace is read-only: do not call mutating workspace tools. `edit` is unavailable, and `write` may only target `local://` plan or scratch artifacts.",
    "- Use `read`, `search`, `find`, `web_search`, `lsp`, `task`, `ask`, and `todo` for investigation and planning.",
    "- Ground every discoverable fact yourself. Every path, symbol, signature, current behavior, test pattern, and config statement in the plan must come from code or docs read in this plan session. Mark anything unverified inline.",
    "- For broad, ambiguous, cross-cutting, or multi-area work, launch parallel `explore` subagents with `task` before finalizing the plan. Give each subagent a distinct focus such as existing implementation, affected callsites, tests, edge cases, or risky integrations.",
    "- Use `task` in one OMP-style batch call when possible: `agent: \"explore\"`, shared `context`, and `tasks: [{ id?, description?, assignment }]`. Keep assignments self-contained with exact paths or discovery targets, explicit non-goals, and concise acceptance criteria.",
    "- Plan-mode subagents are for investigation only. Prefer read-only agents such as `explore` and do not ask subagents to edit files, run mutating commands, format, lint, or run project-wide tests.",
    "- After subagents return, synthesize their reports yourself. Subagents provide evidence; you own the design decision and final plan.",
    "- Ask the user only for preferences or tradeoffs not derivable from repository exploration. Batch questions and recommend a default.",
    `- Keep the current draft plan in \`${planPath}\`; use \`write\` to update that local URL.`,
    "- The plan is an execution spec, not a design doc. It must be self-contained enough that a fresh implementer can execute it without this conversation and without making design decisions.",
    "- Plan contents should cover: context, ordered approach, critical files/anchors, verification, and assumptions/contingencies. Omit decision-free sections such as generic risks, future work, or alternatives unless they settle a concrete implementation choice.",
    "- When the plan is ready for user approval, call hidden `resolve` with `action: \"apply\"`, a concise `reason`, and optional `extra: { \"planPath\": \"local://...\" }`.",
    "- `resolve apply` submits the plan for user approval only. It must not start implementation in the same turn.",
    "- Implementation begins only after a later explicit user approval such as 'approve and implement' or 'approve and implement as goal'.",
    "- If the user asks to revise the plan, call `resolve` with `action: \"refine\"` and continue planning.",
    "- If the plan should be abandoned, call `resolve` with `action: \"discard\"`.",
    pendingApproval ? "- A plan is currently waiting for user approval. Do not implement it or call mutating tools until explicit approval. You may answer unrelated side questions normally." : undefined,
    approvedPlan ? `- Current plan awaiting approval:\n${approvedPlan}` : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function renderPlanModeStatus(state: PlanModeState): string {
  const lines = [
    "Alpha plan mode is active.",
    "",
    `Draft plan: \`${state.planPath}\``,
    state.pendingApproval ? "Status: waiting for user approval." : undefined,
    "",
    "Workspace edits are blocked until the user approves the plan.",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function renderPlanReview(state: PlanModeState): string {
  const status = state.pendingApproval
    ? "Status: waiting for user approval."
    : state.active
      ? "Status: planning."
      : state.approvedPlan
        ? "Status: approved for implementation."
        : undefined;
  const nextStep = state.pendingApproval || (!state.active && state.approvedPlan)
    ? "Reply `approve and implement as goal`, `approve and implement`, `refine: <change>`, or `discard plan`."
    : "Use plan mode to draft a plan, then submit it for approval.";
  const lines = [
    "Alpha plan review",
    "",
    `Draft plan: \`${state.planPath}\``,
    status,
    state.approvedPlanPath ? `Plan pending approval: \`${state.approvedPlanPath}\`` : undefined,
    state.approvedPlan ? ["", state.approvedPlan].join("\n") : undefined,
    "",
    nextStep,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}
