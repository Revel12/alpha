import {
  completeGoal,
  createGoal,
  dropGoal,
  goalToolResponse,
  parseGoalToolInput,
  renderGoalToolResponse,
  resumeGoal,
} from "../goalMode";
import type { GoalModeState, ToolDefinition } from "../types";

export const goalTool: ToolDefinition = {
  name: "goal",
  summary: "Manage the active OMP-style goal-mode objective.",
  async run(args, ctx) {
    const input = parseGoalToolInput(args);
    let nextState: GoalModeState | undefined = ctx.goalMode;
    let response = goalToolResponse(input.op, nextState?.goal ?? null);

    if (input.op === "create") {
      if (!input.objective?.trim()) throw new Error("objective is required when op=create");
      nextState = createGoal(ctx.goalMode, input.objective, input.tokenBudget);
      response = goalToolResponse(input.op, nextState.goal);
    } else if (input.op === "resume") {
      nextState = resumeGoal(ctx.goalMode);
      response = goalToolResponse(input.op, nextState.goal);
    } else if (input.op === "complete") {
      nextState = completeGoal(ctx.goalMode);
      response = goalToolResponse(input.op, nextState.goal, true);
    } else if (input.op === "drop") {
      const dropped = dropGoal(ctx.goalMode);
      nextState = undefined;
      response = goalToolResponse(input.op, dropped ?? null);
    }

    ctx.setGoalMode?.(nextState);
    if (!ctx.setGoalMode) {
      ctx.goalMode = nextState;
      ctx.persistSession?.();
    }

    return {
      markdown: renderGoalToolResponse(response),
      details: response,
    };
  },
};
