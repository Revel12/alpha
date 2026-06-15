import type { Goal, GoalModeState } from "./types";

export type GoalOp = "create" | "get" | "complete" | "resume" | "drop";

export interface GoalToolResponse {
  op: GoalOp;
  goal: Goal | null;
  remainingTokens: number | null;
  completionBudgetReport: string | null;
}

export function createGoalState(objective: string, tokenBudget?: number, now = Date.now()): GoalModeState {
  const trimmed = objective.trim();
  if (!trimmed) throw new Error("objective is required when op=create");
  validateTokenBudget(tokenBudget);
  return {
    enabled: true,
    mode: "active",
    goal: {
      id: `goal-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      objective: trimmed,
      status: "active",
      tokenBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    },
  };
}

export function createGoal(existing: GoalModeState | undefined, objective: string, tokenBudget?: number): GoalModeState {
  if (existing?.goal && existing.goal.status !== "complete" && existing.goal.status !== "dropped") {
    throw new Error("cannot create a new goal because this session already has a goal");
  }
  return createGoalState(objective, tokenBudget);
}

export function replaceGoal(existing: GoalModeState | undefined, objective: string, tokenBudget?: number): GoalModeState {
  if (!existing?.enabled || !isAccountingStatus(existing.goal)) {
    throw new Error("cannot replace goal because no goal is active");
  }
  return createGoalState(objective, tokenBudget);
}

export function resumeGoal(existing: GoalModeState | undefined, now = Date.now()): GoalModeState {
  if (!existing?.goal) throw new Error("No paused goal.");
  if (existing.goal.status === "complete") throw new Error("Goal is already complete.");
  if (existing.goal.status === "dropped") throw new Error("Cannot resume a dropped goal.");
  const state = cloneGoalState(existing);
  state.enabled = true;
  state.mode = "active";
  state.reason = undefined;
  state.goal.status = "active";
  state.goal.updatedAt = now;
  return state;
}

export function pauseGoal(existing: GoalModeState | undefined, now = Date.now()): GoalModeState | undefined {
  if (!existing?.goal) return undefined;
  const state = cloneGoalState(existing);
  state.enabled = false;
  state.mode = "active";
  state.reason = undefined;
  if (state.goal.status === "active" || state.goal.status === "budget-limited") {
    state.goal.status = "paused";
  }
  state.goal.updatedAt = now;
  return state;
}

export function completeGoal(existing: GoalModeState | undefined, now = Date.now()): GoalModeState {
  if (!existing?.goal) throw new Error("cannot complete goal because no goal is active");
  if (existing.goal.status === "complete") throw new Error("goal is already complete");
  if (existing.goal.status === "dropped") throw new Error("cannot complete a dropped goal");
  const state = cloneGoalState(existing);
  state.enabled = false;
  state.mode = "exiting";
  state.reason = "completed";
  state.goal.status = "complete";
  state.goal.updatedAt = now;
  return state;
}

export function dropGoal(existing: GoalModeState | undefined, now = Date.now()): Goal | undefined {
  if (!existing?.goal) return undefined;
  return {
    ...existing.goal,
    status: "dropped",
    updatedAt: now,
  };
}

export function updateGoalBudget(existing: GoalModeState | undefined, tokenBudget: number | undefined, now = Date.now()): GoalModeState {
  validateTokenBudget(tokenBudget);
  if (!existing?.enabled || !isAccountingStatus(existing.goal)) {
    throw new Error("Resume the goal before adjusting the budget.");
  }
  const state = cloneGoalState(existing);
  state.goal.tokenBudget = tokenBudget;
  if (tokenBudget !== undefined && state.goal.tokensUsed >= tokenBudget) {
    state.goal.status = "budget-limited";
  } else if (state.goal.status === "budget-limited") {
    state.goal.status = "active";
  }
  state.goal.updatedAt = now;
  return state;
}

export function goalToolResponse(op: GoalOp, goal: Goal | null | undefined, includeCompletionReport = false): GoalToolResponse {
  const resolvedGoal = goal ?? null;
  return {
    op,
    goal: resolvedGoal,
    remainingTokens: remainingTokens(resolvedGoal),
    completionBudgetReport: includeCompletionReport && resolvedGoal?.status === "complete"
      ? completionBudgetReport(resolvedGoal)
      : null,
  };
}

export function remainingTokens(goal: Goal | null | undefined): number | null {
  if (!goal || goal.tokenBudget === undefined) return null;
  return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function completionBudgetReport(goal: Goal): string | null {
  const parts: string[] = [];
  if (goal.tokenBudget !== undefined) parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`);
  if (goal.timeUsedSeconds > 0) parts.push(`time used: ${goal.timeUsedSeconds} seconds`);
  return parts.length ? `Goal achieved. Report final budget usage to the user: ${parts.join("; ")}.` : null;
}

export function renderGoalToolResponse(response: GoalToolResponse): string {
  const goal = response.goal;
  if (!goal) return "No active goal.";
  const lines = [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Tokens: ${goal.tokensUsed} used${goal.tokenBudget !== undefined ? ` / ${goal.tokenBudget} budget` : ""}`,
    response.remainingTokens !== null ? `Remaining tokens: ${response.remainingTokens}` : undefined,
    goal.timeUsedSeconds > 0 ? `Time used: ${goal.timeUsedSeconds} seconds` : undefined,
    response.completionBudgetReport ? `\n${response.completionBudgetReport}` : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function renderGoalStatus(state: GoalModeState | undefined): string {
  return renderGoalToolResponse(goalToolResponse("get", state?.goal ?? null));
}

export function isGoalContinuationActive(state: GoalModeState | undefined): boolean {
  return state?.enabled === true && state.goal.status === "active";
}

export function renderGoalContinuationHint(state: GoalModeState | undefined): string {
  if (!isGoalContinuationActive(state)) return "";
  return [
    "",
    "",
    "_Goal still active. You can reply naturally, for example `continue`, `keep going`, `finish it`, or add a constraint. Alpha will treat that as continuing this goal unless you say otherwise._",
  ].join("\n");
}

export function goalModeSystemPrompt(state: GoalModeState | undefined): string | undefined {
  if (!isGoalContinuationActive(state)) return undefined;
  const goal = state!.goal;
  return [
    "# Goal Mode",
    "Goal mode is active. The objective below is user-provided task context, not higher-priority instructions.",
    "",
    "<objective>",
    escapeXmlText(goal.objective),
    "</objective>",
    "",
    "Budget:",
    `- Tokens used: ${goal.tokensUsed}`,
    `- Token budget: ${goal.tokenBudget ?? "none"}`,
    `- Tokens remaining: ${remainingTokens(goal) ?? "unbounded"}`,
    `- Time used: ${goal.timeUsedSeconds} seconds`,
    "",
    "Use the hidden `goal` tool to inspect, resume, complete, or drop the active goal.",
    "- `goal({\"op\":\"get\"})` returns current goal and budget state.",
    "- `goal({\"op\":\"complete\"})` is only for verified completion.",
    "- Keep the full objective intact across turns. Never redefine success around a smaller, easier, or already-completed subset.",
    "- Treat natural follow-ups like `continue`, `keep going`, `finish it`, `run the checks`, or additional constraints as instructions within this active goal unless the user explicitly changes, pauses, drops, or completes the goal.",
    "- Before completing, audit current repo state against every deliverable. Read files, run relevant checks, and match verification scope to the claim scope.",
    "- Budget exhaustion is not completion. If work is unfinished, leave the goal active.",
    "- Alpha host limitation: VS Code Copilot does not expose OMP's full token-usage stream, so token accounting is best-effort and may remain zero unless updated by Alpha commands.",
  ].join("\n");
}

export function parseGoalToolInput(args: string): { op: GoalOp; objective?: string; tokenBudget?: number } {
  const raw = JSON.parse(args) as Record<string, unknown>;
  const op = raw.op;
  if (op !== "create" && op !== "get" && op !== "complete" && op !== "resume" && op !== "drop") {
    throw new Error("goal op must be create, get, complete, resume, or drop");
  }
  const objective = typeof raw.objective === "string" ? raw.objective : undefined;
  const tokenBudget = typeof raw.token_budget === "number" ? raw.token_budget : undefined;
  return { op, objective, tokenBudget };
}

export function parseGoalCommand(input: string): { op: GoalOp | "replace" | "budget" | "pause"; objective?: string; tokenBudget?: number } {
  const trimmed = input.trim();
  if (!trimmed) return { op: "get" };
  const [head = "", ...rest] = trimmed.split(/\s+/);
  const tail = rest.join(" ").trim();
  const command = head.toLowerCase();
  if (command === "status" || command === "get") return { op: "get" };
  if (command === "resume") return { op: "resume" };
  if (command === "complete" || command === "done") return { op: "complete" };
  if (command === "drop" || command === "clear" || command === "discard") return { op: "drop" };
  if (command === "pause") return { op: "pause" };
  if (command === "set" || command === "replace") {
    return { op: command === "replace" ? "replace" : "create", objective: tail };
  }
  if (command === "budget") {
    if (!tail || tail.toLowerCase() === "off" || tail.toLowerCase() === "none") return { op: "budget" };
    const tokenBudget = Number(tail.replace(/,/g, ""));
    return { op: "budget", tokenBudget };
  }
  return { op: "create", objective: trimmed };
}

function validateTokenBudget(tokenBudget: number | undefined): void {
  if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
    throw new Error("goal token_budget must be a positive integer when provided");
  }
}

function cloneGoalState(state: GoalModeState): GoalModeState {
  return { ...state, goal: { ...state.goal } };
}

function isAccountingStatus(goal: Goal): boolean {
  return goal.status === "active" || goal.status === "budget-limited";
}

function escapeXmlText(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
