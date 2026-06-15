import * as vscode from "vscode";
import { applyWorkspaceEdits } from "./patch/hashline";
import { AlphaSessionManager } from "./sessionState";
import type { AlphaSessionState } from "./sessionState";
import { buildAlphaTranscript } from "./transcript";
import type { AlphaContext } from "./types";
import { alphaContextUsageForPrompt, answerWithAlphaTools } from "./lmTools";
import { runAlphaCommit } from "./commitWorkflow";
import { compactTranscriptWithModel, compactableTranscriptEntries, formatContextUsage } from "./contextManager";
import {
  completeGoal,
  createGoal,
  dropGoal,
  goalToolResponse,
  parseGoalCommand,
  pauseGoal,
  renderGoalStatus,
  renderGoalToolResponse,
  replaceGoal,
  resumeGoal,
  updateGoalBudget,
} from "./goalMode";
import { resolveInternalUrl } from "./internalUrls";
import { buildPlanGoalObjective, createPlanModeState, isPlanApprovalAsGoalPrompt, renderPlanModeStatus, renderPlanReview } from "./planMode";
import { buildInteractiveReviewPrompt } from "./reviewCore";
import { workspaceRoot } from "./workspace";

let sessions: AlphaSessionManager;

export function activate(context: vscode.ExtensionContext): void {
  sessions = new AlphaSessionManager(context);
  const participant = vscode.chat.createChatParticipant("alpha.participant", async (request, chatContext, stream, token) => {
    await handleAlphaRequest(context, request, chatContext, stream, token);
  });
  participant.iconPath = new vscode.ThemeIcon("hubot");

  context.subscriptions.push(
    participant,
    vscode.commands.registerCommand("alpha.openPendingEdits", async () => {
      const session = sessions.latest();
      const edits = session?.pendingEdits.list() ?? [];
      if (!edits.length) {
        void vscode.window.showInformationMessage("Alpha has no pending edits.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        edits.map((edit) => ({
          label: edit.id,
          description: `${edit.edits.length} change(s)`,
          detail: edit.label,
          edit,
        })),
        { title: "Alpha Pending Edits" },
      );
      if (picked) {
        void vscode.window.showInformationMessage(`${picked.label}: ${picked.detail}`);
      }
    }),
    vscode.commands.registerCommand("alpha.applyPendingEdit", async () => {
      const session = sessions.latest();
      const edits = session?.pendingEdits.list() ?? [];
      if (!edits.length) {
        void vscode.window.showInformationMessage("Alpha has no pending edits.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        edits.map((edit) => ({
          label: edit.id,
          description: `${edit.edits.length} change(s)`,
          detail: edit.label,
          edit,
        })),
        { title: "Apply Alpha Pending Edit" },
      );
      if (!picked) return;
      const ok = await applyWorkspaceEdits(picked.edit.edits);
      if (ok) {
        session?.pendingEdits.remove(picked.edit.id);
        void vscode.window.showInformationMessage(`Applied ${picked.edit.id}.`);
      } else {
        void vscode.window.showErrorMessage(`VS Code rejected ${picked.edit.id}.`);
      }
    }),
    vscode.commands.registerCommand("alpha.clearPendingEdits", () => {
      sessions.latest()?.pendingEdits.clear();
      void vscode.window.showInformationMessage("Cleared Alpha pending edits.");
    }),
    vscode.commands.registerCommand("alpha.inspectVsCodeTools", () => {
      const output = vscode.window.createOutputChannel("Alpha: VS Code LM Tools");
      output.clear();
      output.appendLine(`VS Code LM tools visible to Alpha: ${vscode.lm.tools.length}`);
      output.appendLine("");

      if (!vscode.lm.tools.length) {
        output.appendLine("No tools are currently registered in vscode.lm.tools.");
        output.appendLine("If browser tools are enabled only inside Copilot's built-in agent, they may not be exposed to third-party chat participants.");
      }

      for (const tool of vscode.lm.tools) {
        output.appendLine(`- ${tool.name}`);
        if (tool.tags.length) output.appendLine(`  tags: ${tool.tags.join(", ")}`);
        if (tool.description) output.appendLine(`  description: ${tool.description}`);
        if (tool.inputSchema) output.appendLine(`  inputSchema: ${JSON.stringify(tool.inputSchema)}`);
        output.appendLine("");
      }

      const browserTools = vscode.lm.tools.filter((tool) => {
        const text = `${tool.name} ${tool.description} ${tool.tags.join(" ")}`.toLowerCase();
        return text.includes("browser") || text.includes("page") || text.includes("playwright");
      });
      output.appendLine(`Likely browser/page/playwright tools: ${browserTools.length ? browserTools.map((tool) => tool.name).join(", ") : "(none)"}`);
      output.show(true);
    }),
  );
}

export function deactivate(): void {
  sessions.clear();
}

async function handleAlphaRequest(
  extensionContext: vscode.ExtensionContext,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const parsedRequest = parseAlphaChatRequest(request);
  const session = sessions.get(chatContext, request);
  const transcript = buildAlphaTranscript(chatContext.history, {
    compactionSummary: session.compactionSummary,
    compactedThroughHistoryIndex: session.compactedThroughHistoryIndex,
  });
  const alphaContext: AlphaContext = {
    extensionContext,
    sessionKey: session.key,
    sessionLabel: session.label,
    compactionSummary: session.compactionSummary,
    compactedThroughHistoryIndex: session.compactedThroughHistoryIndex,
    request,
    chatContext,
    transcript,
    stream,
    token,
    pendingEdits: session.pendingEdits,
    todos: session.todos,
    snapshots: session.snapshots,
    artifacts: session.artifacts,
    bashJobs: session.bashJobs,
    conflicts: session.conflicts,
    permissionDecisions: session.permissionDecisions,
    discoveredTools: session.discoveredTools,
    planMode: session.planMode,
    goalMode: session.goalMode,
    persistSession: () => sessions.persistNow(),
    setCompaction: (summary, compactedThroughHistoryIndex) => {
      session.compactionSummary = summary;
      session.compactedThroughHistoryIndex = compactedThroughHistoryIndex;
      alphaContext.compactionSummary = summary;
      alphaContext.compactedThroughHistoryIndex = compactedThroughHistoryIndex;
      sessions.persistNow();
    },
    setGoalMode: (state) => {
      session.goalMode = state;
      alphaContext.goalMode = state;
      sessions.persistNow();
    },
  };

  try {
    if (!parsedRequest.command && (!parsedRequest.prompt || parsedRequest.prompt === "help")) {
      stream.markdown("Alpha is an OMP-style VS Code chat participant. Invoke it with `@a` and ask naturally, e.g. `read src/foo.ts and explain it` or `search for TODO comments`.");
      return;
    }

    if (parsedRequest.command === "commit") {
      await runAlphaCommit(parsedRequest.prompt, alphaContext);
      return;
    }

    if (parsedRequest.command === "context") {
      const usage = await alphaContextUsageForPrompt(parsedRequest.prompt || "context usage", alphaContext);
      stream.markdown([
        `Alpha context usage: ${formatContextUsage(usage)}`,
        "",
        `Model: ${request.model.name}`,
        `Max input tokens: ${usage.maxInputTokens.toLocaleString()}`,
        `Compacted through history index: ${session.compactedThroughHistoryIndex ?? "none"}`,
        session.compactionSummary ? "Compaction summary: present" : "Compaction summary: none",
      ].join("\n"));
      return;
    }

    if (parsedRequest.command === "goal") {
      await handleGoalCommand(parsedRequest.prompt, session, alphaContext);
      return;
    }

    if (parsedRequest.command === "compact") {
      await compactAlphaSession(parsedRequest.prompt, session, alphaContext);
      return;
    }

    if (parsedRequest.command === "plan") {
      if (session.goalMode?.enabled) {
        stream.markdown("Exit or complete the active Alpha goal before entering plan mode.");
        return;
      }
      await handlePlanCommand(parsedRequest.prompt, session, alphaContext);
      return;
    }

    if (parsedRequest.command === "plan-review") {
      await handlePlanReviewCommand(parsedRequest.prompt, session, alphaContext);
      return;
    }

    if (!parsedRequest.command && session.planMode && (session.planMode.pendingApproval || session.planMode.approvedPlan)) {
      const handled = await handlePlanDecisionPrompt(parsedRequest.prompt, session, alphaContext);
      if (handled) return;
    }

    const expandedPrompt = await expandAlphaCommand(parsedRequest);
    if (expandedPrompt === undefined) return;
    await answerWithAlphaTools(expandedPrompt, alphaContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stream.markdown(`Alpha error: ${message}`);
  }
}

async function handleGoalCommand(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  if (session.planMode?.active) {
    ctx.stream.markdown("Exit Alpha plan mode before starting or changing a goal.");
    return;
  }

  const parsed = parseGoalCommand(prompt);
  if (parsed.op === "get") {
    ctx.stream.markdown(renderGoalStatus(session.goalMode));
    return;
  }

  if (parsed.op === "create") {
    const next = createGoal(session.goalMode, parsed.objective ?? "", parsed.tokenBudget);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(renderGoalToolResponse(goalToolResponse("create", next.goal)));
    return;
  }

  if (parsed.op === "replace") {
    const next = replaceGoal(session.goalMode, parsed.objective ?? "", parsed.tokenBudget);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(renderGoalToolResponse(goalToolResponse("create", next.goal)));
    return;
  }

  if (parsed.op === "resume") {
    const next = resumeGoal(session.goalMode);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(renderGoalToolResponse(goalToolResponse("resume", next.goal)));
    return;
  }

  if (parsed.op === "pause") {
    const next = pauseGoal(session.goalMode);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(next ? renderGoalToolResponse(goalToolResponse("get", next.goal)) : "No active goal.");
    return;
  }

  if (parsed.op === "budget") {
    const next = updateGoalBudget(session.goalMode, parsed.tokenBudget);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(renderGoalToolResponse(goalToolResponse("get", next.goal)));
    return;
  }

  if (parsed.op === "complete") {
    const next = completeGoal(session.goalMode);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(renderGoalToolResponse(goalToolResponse("complete", next.goal, true)));
    return;
  }

  if (parsed.op === "drop") {
    const dropped = dropGoal(session.goalMode);
    ctx.setGoalMode?.(undefined);
    ctx.stream.markdown(dropped ? renderGoalToolResponse(goalToolResponse("drop", dropped)) : "No active goal.");
  }
}

async function compactAlphaSession(
  note: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  const compactable = compactableTranscriptEntries(ctx.transcript);
  const lastHistoryIndex = compactable.at(-1)?.historyIndex;
  if (lastHistoryIndex === undefined) {
    ctx.stream.markdown("No Alpha chat history is available to compact.");
    return;
  }
  const usage = await alphaContextUsageForPrompt(note || "compact current Alpha session", ctx);
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
  session.compactionSummary = result.summary;
  session.compactedThroughHistoryIndex = result.compactedThroughHistoryIndex;
  ctx.compactionSummary = result.summary;
  ctx.compactedThroughHistoryIndex = result.compactedThroughHistoryIndex;
  sessions.persistNow();
  ctx.stream.markdown([
    "Alpha compaction complete.",
    "",
    `Compacted through history index: ${result.compactedThroughHistoryIndex}`,
    `Tokens before: ${result.tokensBefore.toLocaleString()}`,
    "",
    result.summary,
  ].join("\n"));
}

async function handlePlanReviewCommand(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  const state = session.planMode;
  if (!state) {
    ctx.stream.markdown("No Alpha plan is available in this chat session.");
    return;
  }

  const planPath = state.approvedPlanPath ?? state.planPath;
  let plan = state.approvedPlan;
  if (!plan) {
    try {
      plan = (await resolveInternalUrl(planPath, ctx)).content;
    } catch {
      ctx.stream.markdown("No plan to review yet. Ask Alpha to write one to `local://alpha-plan.md` first.");
      return;
    }
  }

  const contextUsage = await alphaContextUsageForPrompt("plan review", ctx);
  if (!state.active && state.approvedPlan && !state.pendingApproval) {
    ctx.stream.markdown([
      renderPlanReview(state),
      "",
      `Current context: ${formatContextUsage(contextUsage)}`,
      "",
      "This plan is not waiting for approval. Type `approve and implement as goal` to retry it with goal tracking, `approve and implement` to retry once, `refine: <what to change>` to revise it, or `discard plan` to clear it.",
    ].join("\n"));
    return;
  }

  state.approvedPlan = plan;
  state.approvedPlanPath = planPath;
  state.planPath = planPath;
  state.pendingApproval = true;
  state.updatedAt = new Date().toISOString();
  ctx.planMode = state;
  sessions.persistNow();
  ctx.stream.markdown(`${renderPlanReview(state)}\n\nCurrent context: ${formatContextUsage(contextUsage)}\n\nType one of:\n- \`approve and implement as goal\`\n- \`approve and implement\`\n- \`refine: <what to change>\`\n- \`discard plan\``);
}

async function handlePlanDecisionPrompt(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<boolean> {
  const state = session.planMode;
  if (!state || (!state.pendingApproval && !state.approvedPlan)) return false;

  if (isPlanDiscardPrompt(prompt)) {
    session.planMode = undefined;
    ctx.planMode = undefined;
    sessions.persistNow();
    ctx.stream.markdown("Discarded Alpha plan.");
    return true;
  }

  if (isPlanRefinePrompt(prompt)) {
    state.active = true;
    state.pendingApproval = false;
    state.updatedAt = new Date().toISOString();
    ctx.planMode = state;
    sessions.persistNow();

    const refinement = prompt.replace(/^\s*(refine|revise|change|update|modify)(\s+plan)?\s*[:,-]?\s*/i, "").trim();
    if (!refinement) {
      ctx.stream.markdown(`${renderPlanReview(state)}\n\nTell me what to change in the plan.`);
      return true;
    }

    ctx.stream.markdown(`${renderPlanReview(state)}\n\nRefining the plan from your instructions.\n\n`);
    await answerWithAlphaTools(`Refine the pending Alpha plan with this user instruction: ${refinement}`, ctx);
    return true;
  }

  if (isPlanApprovalPrompt(prompt)) {
    await approvePlanAndExecute(prompt, session, ctx);
    return true;
  }

  return false;
}

async function approvePlanAndExecute(
  userApprovalMessage: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  const state = session.planMode;
  if (!state) {
    ctx.stream.markdown("No active Alpha plan is waiting for approval.");
    return;
  }
  if (!state.active && !state.approvedPlan) {
    ctx.stream.markdown("No active or approved Alpha plan is waiting for implementation.");
    return;
  }

  const approvedPlanPath = state.approvedPlanPath ?? state.planPath;
  const approvedPlan = state.approvedPlan ?? (await resolveInternalUrl(approvedPlanPath, ctx)).content;
  const executeAsGoal = isPlanApprovalAsGoalPrompt(userApprovalMessage);
  state.approvedPlan = approvedPlan;
  state.approvedPlanPath = approvedPlanPath;
  state.active = false;
  state.pendingApproval = false;
  state.updatedAt = new Date().toISOString();
  ctx.planMode = state;
  if (executeAsGoal) {
    if (session.goalMode?.goal && session.goalMode.goal.status !== "complete" && session.goalMode.goal.status !== "dropped") {
      ctx.stream.markdown("An Alpha goal is already active. Complete, pause, or drop it before approving this plan as a new goal.");
      sessions.persistNow();
      return;
    }
    const goalState = createGoal(
      session.goalMode,
      buildPlanGoalObjective(approvedPlan, approvedPlanPath, userApprovalMessage),
    );
    ctx.setGoalMode?.(goalState);
  }
  sessions.persistNow();

  const executionPrompt = [
    executeAsGoal
      ? "The user explicitly approved the pending Alpha plan as an active Alpha goal. Implement the approved plan now while preserving the goal until verified complete."
      : "The user explicitly approved the pending Alpha plan. Implement it now.",
    `\nApproved plan:\n${approvedPlan}`,
    userApprovalMessage ? `\nUser approval message:\n${userApprovalMessage}` : "",
  ].join("\n");
  await answerWithAlphaTools(executionPrompt, ctx);
}

function isPlanApprovalPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/\b(cancel|discard|abandon|revise|refine|change|update|modify|not yet|don't|do not)\b/.test(text)) return false;
  return /\b(approve|approved|apply|implement|execute|proceed|go ahead|start)\b/.test(text);
}

function isPlanRefinePrompt(prompt: string): boolean {
  return /\b(refine|revise|change|update|modify)\b/i.test(prompt);
}

function isPlanDiscardPrompt(prompt: string): boolean {
  return /\b(discard|cancel|abandon|drop)\b/i.test(prompt);
}

async function handlePlanCommand(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  if (session.planMode?.active) {
    if (!prompt) {
      session.planMode = undefined;
      ctx.planMode = undefined;
      sessions.persistNow();
      ctx.stream.markdown("Exited Alpha plan mode without applying a plan.");
      return;
    }

    ctx.stream.markdown(`${renderPlanModeStatus(session.planMode)}\n\n`);
    await answerWithAlphaTools(prompt, ctx);
    return;
  }

  session.planMode = createPlanModeState(prompt || undefined);
  ctx.planMode = session.planMode;
  sessions.persistNow();

  if (!prompt) {
    ctx.stream.markdown(`${renderPlanModeStatus(session.planMode)}\n\nSend \`@a /plan <goal>\` to start planning, or ask naturally in this chat while plan mode is active.`);
    return;
  }

  await answerWithAlphaTools(prompt, ctx);
}

interface ParsedAlphaChatRequest {
  command?: string;
  prompt: string;
}

function parseAlphaChatRequest(request: vscode.ChatRequest): ParsedAlphaChatRequest {
  const prompt = request.prompt.trim();
  const command = request.command?.trim();
  if (command) return { command, prompt };

  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!match) return { prompt };

  return {
    command: match[1],
    prompt: (match[2] ?? "").trim(),
  };
}

async function expandAlphaCommand(request: ParsedAlphaChatRequest): Promise<string | undefined> {
  if (!request.command) return request.prompt;
  if (request.command !== "review") return `/${request.command}${request.prompt ? ` ${request.prompt}` : ""}`;
  const expanded = await buildInteractiveReviewPrompt(request.prompt, workspaceRoot().fsPath);
  if (!expanded) return undefined;
  return expanded;
}
