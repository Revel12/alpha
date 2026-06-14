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
    "- Use `read`, `search`, `find`, `web_search`, `lsp`, `ask`, and `todo` for investigation and planning.",
    `- Keep the current draft plan in \`${planPath}\`; use \`write\` to update that local URL.`,
    "- When the plan is ready for user approval, call hidden `resolve` with `action: \"apply\"`, a concise `reason`, and optional `extra: { \"planPath\": \"local://...\" }`.",
    "- `resolve apply` submits the plan for user approval only. It must not start implementation in the same turn.",
    "- Implementation begins only after a later explicit user approval such as 'approve and implement'.",
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
    ? "Reply `approve and implement`, `refine: <change>`, or `discard plan`."
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
