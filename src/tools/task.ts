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
  allocateTaskId,
  discoverAgents,
  getAgent,
  parseTaskInput,
  renderCombinedTaskResult,
  renderSubagentPrompt,
  renderTaskDescription,
  renderTaskSummary,
  resolveSpawnItems,
  spawnParamsFor,
  truncateTaskOutput,
  validateShapeParams,
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

    if (params.isolated || (params.tasks ?? []).some((task) => task.isolated)) {
      return {
        markdown: "Task isolation is not available in Alpha's VS Code chat participant host. Re-run without `isolated`, or create an explicit git worktree/branch yourself before delegating.",
      };
    }

    const { agents } = await discoverAgents(workspaceCwd());
    const agent = getAgent(agents, params.agent ?? "");
    if (!agent) {
      return { markdown: `Unknown agent "${params.agent ?? ""}". Available: ${agents.map((item) => item.name).join(", ") || "none"}` };
    }

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
  const existingIds = new Set(ctx.bashJobs.list().map((job) => job.id));
  const started: Array<{ id: string; jobId: string; description?: string }> = [];
  for (let index = 0; index < spawnItems.length; index++) {
    const item = spawnItems[index];
    const id = allocateTaskId(item.id, existingIds);
    existingIds.add(id);
    const spawnParams = spawnParamsFor(params, { ...item, id });
    const controller = new AbortController();
    const job = ctx.bashJobs.add({
      type: "task",
      command: `${agent.name}: ${item.description ?? item.assignment ?? id}`,
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
    started.push({ id, jobId: job.id, description: item.description });
  }

  if (started.length === 1) {
    const item = started[0];
    const suffix = item.description ? ` - ${item.description}` : "";
    return `Spawned agent \`${item.id}\` (job \`${item.jobId}\`)${suffix}. The result will be stored on the job; use \`job\` to inspect, poll, or cancel it.`;
  }

  return [
    `Spawned ${started.length} background agents using ${agent.name}. Each result will be stored on its job.`,
    ...started.map((item) => `- \`${item.id}\` (job \`${item.jobId}\`)${item.description ? ` - ${item.description}` : ""}`),
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
  const results: SingleResult[] = new Array(spawnItems.length);
  let nextIndex = 0;
  const workerCount = Math.min(taskMaxConcurrency(), spawnItems.length);

  async function worker(): Promise<void> {
    while (nextIndex < spawnItems.length) {
      const index = nextIndex++;
      const item = spawnItems[index];
      const id = allocateTaskId(item.id, existingIds);
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
  const progress: AgentProgress = {
    index,
    id,
    agent: agent.name,
    agentSource: agent.source,
    status: "running",
    task: assignment,
    assignment,
    description: params.description,
    recentOutput: [],
    toolCount: 0,
    requests: 0,
    durationMs: 0,
  };

  try {
    const output = await runSubagentModelLoop(parentCtx, agent, params, id, progress, token);
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
    return {
      index,
      id,
      agent: agent.name,
      agentSource: agent.source,
      task: assignment,
      assignment,
      description: params.description,
      exitCode: aborted ? 130 : 1,
      output: "",
      stderr: message,
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
  const activeTools = toolsForAgent(agent, parentCtx);
  const activeToolNames = new Set(activeTools.map((tool) => tool.name));
  const subagentCtx: AlphaContext = {
    ...parentCtx,
    sessionKey: `${parentCtx.sessionKey}:task:${id}`,
    sessionLabel: `${parentCtx.sessionLabel} / ${id}`,
    compactionSummary: undefined,
    transcript: [],
    token: toCancellationToken(token),
  };
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
  const requested = (agent.tools?.length ? agent.tools : ["read", "bash", "search", "find", "edit", "write", "lsp", "job", "todo"])
    .filter((name) => name !== "task");
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

function workspaceCwd(): string {
  return workspaceRoot().fsPath;
}
