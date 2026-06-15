import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { ensureToolPermission } from "../approval";
import { registerAsyncBashController, unregisterAsyncBashController } from "../asyncBashJobs";
import { taskApproval, taskApprovalDetails } from "../approvalCore";
import {
  injectReviewFindings,
  parseReportFindingDetails,
  parseReviewYieldDetails,
  toReviewFinding,
  type ReviewFinding,
  type ReviewFindingDetails,
  type ReviewYieldDetails,
} from "../reviewCore";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_OUTPUT_LINES,
  DEFAULT_MAX_RECURSION_DEPTH,
  agentForPlanMode,
  agentToolNames,
  allocateNestedTaskId,
  discoverAgents,
  getAgent,
  normalizeSpawnAllowance,
  parseTaskInput,
  renderCombinedTaskResult,
  renderSubagentPrompt,
  renderTaskDescription,
  renderTaskSummary,
  resolveSubagentDisplayName,
  resolveSpawnItems,
  spawnParamsFor,
  truncateTaskOutput,
  validateAgentOutput,
  validateShapeParams,
  validateSpawnPermission,
  validateSpawnParams,
  type AgentDefinition,
  type AgentProgress,
  type SingleResult,
  type TaskParams,
} from "../taskCore";
import { getAdvertisedAlphaLanguageModelTools, runRegisteredAlphaTool } from "../toolRegistry";
import { wrapInternalForModel } from "../transcript";
import type { AlphaContext, ToolDefinition } from "../types";
import { workspaceRoot } from "../workspace";

const SUBAGENT_SOFT_REQUEST_BUDGETS: Record<string, number> = {
  explore: 40,
  quick_task: 40,
  default: 90,
};

export const taskTool: ToolDefinition = {
  name: "task",
  summary: "Spawn Alpha subagents to complete delegated tasks.",
  async run(args, ctx) {
    const params = parseTaskInput(args);
    await ensureToolPermission(
      { name: "task", approval: taskApproval, formatApprovalDetails: taskApprovalDetails },
      params,
      ctx,
    );

    const batchEnabled = taskBatchEnabled();
    const validationError = validateShapeParams(batchEnabled, params) ?? validateSpawnParams(params, batchEnabled);
    if (validationError) return { markdown: validationError };
    const permissionError = validateSpawnPermission({
      agentName: params.agent ?? "",
      allowedSpawns: ctx.taskAllowedSpawns,
      blockedAgent: ctx.taskBlockedAgent,
      taskDepth: ctx.taskDepth,
      maxRecursionDepth: taskMaxRecursionDepth(),
    });
    if (permissionError) return { markdown: permissionError };

    if (params.isolated || (params.tasks ?? []).some((task) => task.isolated)) {
      return {
        markdown: "Task isolation is not available in Alpha's VS Code chat participant host. Re-run without `isolated`, or create an explicit git worktree/branch yourself before delegating.",
      };
    }

    const { agents } = await discoverAgents(workspaceCwd());
    const discoveredAgent = getAgent(agents, params.agent ?? "");
    if (!discoveredAgent) {
      return { markdown: `Unknown agent "${params.agent ?? ""}". Available: ${agents.map((item) => item.name).join(", ") || "none"}` };
    }
    const agent = ctx.planMode?.active ? agentForPlanMode(discoveredAgent) : discoveredAgent;

    const spawnItems = resolveSpawnItems(params);
    if (taskAsyncEnabled() && agent.blocking !== true) {
      return { markdown: startBackgroundTasks(params, agent, spawnItems, ctx) };
    }

    const startedAt = performance.now();
    const results = await runSpawnItems(params, agent, spawnItems, ctx);
    return { markdown: renderCombinedTaskResult(results, Math.round(performance.now() - startedAt)) };
  },
};

export async function taskDescription(): Promise<string> {
  const { agents } = await discoverAgents();
  return renderTaskDescription(agents, {
    asyncEnabled: taskAsyncEnabled(),
    batchEnabled: taskBatchEnabled(),
    maxConcurrency: taskMaxConcurrency(),
  });
}

function startBackgroundTasks(params: TaskParams, agent: AgentDefinition, spawnItems: ReturnType<typeof resolveSpawnItems>, ctx: AlphaContext): string {
  const existingIds = taskOutputIds(ctx);
  const started: Array<{ id: string; jobId: string; description?: string; role?: string; displayName: string }> = [];
  for (let index = 0; index < spawnItems.length; index++) {
    const item = spawnItems[index];
    const id = allocateNestedTaskId(item.id, existingIds, ctx.taskOutputPrefix);
    existingIds.add(id);
    const spawnParams = spawnParamsFor(params, { ...item, id });
    const displayName = resolveSubagentDisplayName(spawnParams.role, agent.name);
    const controller = new AbortController();
    const job = ctx.bashJobs.add({
      type: "task",
      command: `${displayName}: ${item.description ?? item.assignment ?? id}`,
      cwd: workspaceCwd(),
      status: "running",
    });
    registerAsyncBashController(job.id, controller);
    void runOneSpawn(spawnParams, agent, ctx, index, id, controller.signal)
      .then((result) => {
        const artifact = ctx.artifacts.add(`task ${id} output`, result.output || result.stderr || "");
        ctx.bashJobs.update(job.id, {
          status: result.exitCode === 0 ? "completed" : "failed",
          output: renderTaskSummary({ ...result, outputPath: `agent://${id}` }),
          exitCode: result.exitCode,
          wallTimeMs: result.durationMs,
          artifactId: artifact.id,
          error: result.error,
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.bashJobs.update(job.id, {
          status: controller.signal.aborted ? "cancelled" : "failed",
          exitCode: controller.signal.aborted ? "cancelled" : 1,
          error: message,
          wallTimeMs: 0,
        });
      })
      .finally(() => unregisterAsyncBashController(job.id));
    started.push({ id, jobId: job.id, description: item.description, role: spawnParams.role, displayName });
  }

  if (started.length === 1) {
    const item = started[0];
    const suffix = item.description ? ` - ${item.description}` : "";
    const role = item.role ? ` as ${item.displayName}` : "";
    return `Spawned agent \`${item.id}\` (job \`${item.jobId}\`)${role}${suffix}. The result will be stored on the job; use \`job\` to inspect, poll, or cancel it.`;
  }

  return [
    `Spawned ${started.length} background agents using ${agent.name}. Each result will be stored on its job.`,
    ...started.map((item) => `- \`${item.id}\` (${item.displayName}, job \`${item.jobId}\`)${item.description ? ` - ${item.description}` : ""}`),
    "Use `job` to inspect, poll, or cancel them.",
  ].join("\n");
}

async function runSpawnItems(
  params: TaskParams,
  agent: AgentDefinition,
  spawnItems: ReturnType<typeof resolveSpawnItems>,
  ctx: AlphaContext,
): Promise<SingleResult[]> {
  const existingIds = new Set(ctx.bashJobs.list().map((job) => job.id));
  for (const id of taskOutputIds(ctx)) existingIds.add(id);
  const results: SingleResult[] = new Array(spawnItems.length);
  let nextIndex = 0;
  const workerCount = Math.min(taskMaxConcurrency(), spawnItems.length);

  async function worker(): Promise<void> {
    while (nextIndex < spawnItems.length) {
      const index = nextIndex++;
      const item = spawnItems[index];
      const id = allocateNestedTaskId(item.id, existingIds, ctx.taskOutputPrefix);
      existingIds.add(id);
      results[index] = await runOneSpawn(spawnParamsFor(params, { ...item, id }), agent, ctx, index, id, ctx.token);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function runOneSpawn(
  params: TaskParams,
  agent: AgentDefinition,
  parentCtx: AlphaContext,
  index: number,
  id: string,
  token: vscode.CancellationToken | AbortSignal,
): Promise<SingleResult> {
  const startedAt = performance.now();
  const assignment = (params.assignment ?? "").trim();
  const displayName = resolveSubagentDisplayName(params.role, agent.name);
  const progress: AgentProgress = {
    index,
    id,
    agent: agent.name,
    agentSource: agent.source,
    status: "running",
    task: assignment,
    assignment,
    description: params.description,
    role: params.role,
    displayName,
    recentOutput: [],
    toolCount: 0,
    requests: 0,
    durationMs: 0,
  };

  try {
    const output = await runSubagentModelLoop(parentCtx, agent, params, id, progress, token);
    const validation = validateAgentOutput(output, agent.output);
    if (!validation.ok) {
      const salvage = formatProgressSalvage(progress);
      throw new Error([
        validation.errors.join("\n"),
        salvage ? `\nRecent subagent activity before invalid output:\n${salvage}` : undefined,
        output.trim() ? `\nReturned output:\n${output.trim()}` : undefined,
      ].filter((line): line is string => typeof line === "string").join("\n"));
    }
    const truncated = truncateTaskOutput(output, taskMaxOutputBytes(), taskMaxOutputLines());
    const artifact = parentCtx.artifacts.add(`task ${id} output`, output);
    return {
      index,
      id,
      agent: agent.name,
      agentSource: agent.source,
      task: assignment,
      assignment,
      description: params.description,
      role: params.role,
      displayName,
      exitCode: 0,
      output: truncated.output,
      stderr: "",
      truncated: truncated.truncated,
      durationMs: Math.round(performance.now() - startedAt),
      requests: progress.requests,
      outputPath: `agent://${id}`,
    };
  } catch (error) {
    const aborted = isAborted(token);
    const message = error instanceof Error ? error.message : String(error);
    const salvage = formatProgressSalvage(progress);
    const stderr = salvage && !message.includes("Recent subagent activity")
      ? `${message}\n\nRecent subagent activity:\n${salvage}`
      : message;
    return {
      index,
      id,
      agent: agent.name,
      agentSource: agent.source,
      task: assignment,
      assignment,
      description: params.description,
      role: params.role,
      displayName,
      exitCode: aborted ? 130 : 1,
      output: salvage,
      stderr,
      truncated: false,
      durationMs: Math.round(performance.now() - startedAt),
      requests: progress.requests,
      error: message,
      aborted,
    };
  }
}

async function runSubagentModelLoop(
  parentCtx: AlphaContext,
  agent: AgentDefinition,
  params: TaskParams,
  id: string,
  progress: AgentProgress,
  token: vscode.CancellationToken | AbortSignal,
): Promise<string> {
  const childDepth = (parentCtx.taskDepth ?? 0) + 1;
  const subagentCtx: AlphaContext = {
    ...parentCtx,
    sessionKey: `${parentCtx.sessionKey}:task:${id}`,
    sessionLabel: `${parentCtx.sessionLabel} / ${id}`,
    compactionSummary: undefined,
    transcript: [],
    token: toCancellationToken(token),
    taskDepth: childDepth,
    taskAllowedSpawns: normalizeSpawnAllowance(agent.spawns),
    taskBlockedAgent: agent.name,
    taskOutputPrefix: id,
  };
  const activeTools = toolsForAgent(agent, subagentCtx);
  const activeToolNames = new Set(activeTools.map((tool) => tool.name));
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(
      wrapInternalForModel(renderSubagentPrompt(agent, params), "alpha-system"),
      "alpha_internal",
    ),
  ];
  const reportFindings: ReviewFinding[] = [];
  const softRequestBudget = taskSoftRequestBudget(agent);
  const hardRequestBudget = Math.ceil(softRequestBudget * 1.5);
  let budgetSteerSent = false;

  while (true) {
    if (isAborted(token)) throw new Error("Subagent cancelled.");
    if (progress.requests >= hardRequestBudget) {
      throw new Error(`Subagent soft request budget exceeded (${progress.requests} requests; budget ${softRequestBudget}).`);
    }
    progress.requests += 1;
    const response = await parentCtx.request.model.sendRequest(
      messages,
      {
        tools: activeTools,
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      },
      toCancellationToken(token),
    );

    const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
    const textParts: string[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        assistantParts.push(chunk);
        textParts.push(chunk.value);
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        assistantParts.push(chunk);
        toolCalls.push(chunk);
      }
    }

    if (!toolCalls.length) {
      return textParts.join("").trim() || "(no output)";
    }

    if (assistantParts.length) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    }

    for (const call of toolCalls) {
      progress.toolCount += 1;
      const result = await runRegisteredAlphaTool(call.name, call.input, subagentCtx, activeToolNames);
      const completion = collectSubagentToolData(call.name, result.details, reportFindings);
      if (completion) {
        return finalizeSubagentYield(completion, reportFindings);
      }
      progress.recentOutput.push(`${call.name}: ${result.markdown.slice(0, 500)}`);
      progress.recentOutput = progress.recentOutput.slice(-5);
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result.markdown)]),
        ]),
      );
    }

    if (!budgetSteerSent && progress.requests >= softRequestBudget) {
      budgetSteerSent = true;
      messages.push(
        vscode.LanguageModelChatMessage.User(
          wrapInternalForModel(buildSubagentBudgetNotice(progress.requests), "alpha-system"),
          "alpha_internal",
        ),
      );
    }
  }
}

function toolsForAgent(agent: AgentDefinition, ctx: AlphaContext): vscode.LanguageModelChatTool[] {
  const requested = agentToolNames({
    agent,
    taskDepth: ctx.taskDepth ?? 0,
    maxRecursionDepth: taskMaxRecursionDepth(),
    planModeActive: ctx.planMode?.active,
  });
  return getAdvertisedAlphaLanguageModelTools({ ctx, forceTools: requested, onlyForced: true });
}

function collectSubagentToolData(name: string, details: unknown, reportFindings: ReviewFinding[]): ReviewYieldDetails | undefined {
  if (name === "report_finding") {
    const finding = parseReportFindingDetails(details) ?? parseReportFindingDetails(detailsFromPlainObject(details));
    if (finding) reportFindings.push(toReviewFinding(finding));
    return undefined;
  }
  if (name === "yield") {
    return parseReviewYieldDetails(details) ?? parseReviewYieldDetails(detailsFromPlainObject(details)) ?? {};
  }
  return undefined;
}

function finalizeSubagentYield(completion: ReviewYieldDetails, reportFindings: ReviewFinding[]): string {
  if (completion.status === "aborted") {
    const reason = completion.error ?? "Subagent aborted task.";
    return JSON.stringify({ aborted: true, error: reason }, null, 2);
  }
  const data = completion.data === undefined ? {} : completion.data;
  return JSON.stringify(injectReviewFindings(data, reportFindings), null, 2);
}

function detailsFromPlainObject(details: unknown): ReviewFindingDetails | ReviewYieldDetails | undefined {
  return details && typeof details === "object" && !Array.isArray(details) ? details as ReviewFindingDetails | ReviewYieldDetails : undefined;
}

function toCancellationToken(token: vscode.CancellationToken | AbortSignal): vscode.CancellationToken {
  if ("isCancellationRequested" in token) return token;
  return {
    get isCancellationRequested() {
      return token.aborted;
    },
    onCancellationRequested: (listener: (e: unknown) => unknown) => {
      const abortListener = () => listener(undefined);
      token.addEventListener("abort", abortListener, { once: true });
      return { dispose: () => token.removeEventListener("abort", abortListener) };
    },
  };
}

function isAborted(token: vscode.CancellationToken | AbortSignal): boolean {
  return "isCancellationRequested" in token ? token.isCancellationRequested : token.aborted;
}

function taskBatchEnabled(): boolean {
  return vscode.workspace.getConfiguration("alpha").get<boolean>("task.batch", true);
}

function taskAsyncEnabled(): boolean {
  return vscode.workspace.getConfiguration("alpha").get<boolean>("task.async", true);
}

function taskMaxConcurrency(): number {
  return Math.max(1, Math.min(16, vscode.workspace.getConfiguration("alpha").get<number>("task.maxConcurrency", DEFAULT_MAX_CONCURRENCY)));
}

function taskMaxRecursionDepth(): number {
  const value = vscode.workspace.getConfiguration("alpha").get<number>("task.maxRecursionDepth", DEFAULT_MAX_RECURSION_DEPTH);
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_RECURSION_DEPTH;
  return Math.max(-1, Math.min(20, Math.trunc(value)));
}

function taskMaxOutputBytes(): number {
  return Math.max(1000, vscode.workspace.getConfiguration("alpha").get<number>("task.maxOutputBytes", DEFAULT_MAX_OUTPUT_BYTES));
}

function taskMaxOutputLines(): number {
  return Math.max(100, vscode.workspace.getConfiguration("alpha").get<number>("task.maxOutputLines", DEFAULT_MAX_OUTPUT_LINES));
}

function taskSoftRequestBudget(agent: AgentDefinition): number {
  const override = vscode.workspace.getConfiguration("alpha").get<number>("task.softRequestBudgetOverride", 0);
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.max(1, Math.min(500, Math.trunc(override)));
  }
  return SUBAGENT_SOFT_REQUEST_BUDGETS[agent.name] ?? SUBAGENT_SOFT_REQUEST_BUDGETS.default;
}

function buildSubagentBudgetNotice(requests: number): string {
  return `[budget notice] You have used ${requests} requests in this run. Wrap up now: finish the current step and yield your final report.`;
}

function formatProgressSalvage(progress: AgentProgress): string {
  const lines: string[] = [];
  if (progress.recentOutput.length) lines.push(...progress.recentOutput.map((line) => `- ${flattenSnippet(line)}`));
  if (!lines.length && progress.toolCount > 0) lines.push(`- ${progress.toolCount} tool call${progress.toolCount === 1 ? "" : "s"} completed before the run stopped.`);
  if (!lines.length && progress.requests > 0) lines.push(`- ${progress.requests} model request${progress.requests === 1 ? "" : "s"} completed before the run stopped.`);
  return lines.join("\n");
}

function flattenSnippet(text: string, maxLength = 700): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 3)}...` : flattened;
}

function workspaceCwd(): string {
  return workspaceRoot().fsPath;
}

function taskOutputIds(ctx: AlphaContext): Set<string> {
  const ids = new Set<string>();
  for (const job of ctx.bashJobs.list()) {
    if (job.type === "task") ids.add(job.id);
  }
  for (const artifact of ctx.artifacts.list()) {
    const match = /^task\s+(.+?)\s+output$/i.exec(artifact.label.trim());
    if (match) ids.add(match[1]);
  }
  return ids;
}
