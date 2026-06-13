import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type AgentSource = "bundled" | "user" | "project";
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  spawns?: string[] | "*";
  model?: string[];
  thinkingLevel?: string;
  output?: unknown;
  blocking?: boolean;
  source: AgentSource;
  filePath?: string;
}

export interface TaskItem {
  id?: string;
  description?: string;
  assignment?: string;
  isolated?: boolean;
}

export interface TaskParams {
  agent?: string;
  id?: string;
  description?: string;
  assignment?: string;
  tasks?: TaskItem[];
  context?: string;
  isolated?: boolean;
}

export interface AgentProgress {
  index: number;
  id: string;
  agent: string;
  agentSource: AgentSource;
  status: TaskStatus;
  task: string;
  assignment?: string;
  description?: string;
  recentOutput: string[];
  toolCount: number;
  requests: number;
  durationMs: number;
}

export interface SingleResult {
  index: number;
  id: string;
  agent: string;
  agentSource: AgentSource;
  task: string;
  assignment?: string;
  description?: string;
  exitCode: number;
  output: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  requests: number;
  outputPath?: string;
  error?: string;
  aborted?: boolean;
}

export interface TaskToolDetails {
  projectAgentsDir: string | null;
  results: SingleResult[];
  totalDurationMs: number;
  outputPaths?: string[];
  progress?: AgentProgress[];
  async?: {
    state: "running" | "completed" | "failed";
    jobId: string;
    type: "task";
  };
}

export interface DiscoveryResult {
  agents: AgentDefinition[];
  projectAgentsDir: string | null;
}

const DEFAULT_BATCH_ENABLED = true;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_OUTPUT_BYTES = 500_000;
const DEFAULT_MAX_OUTPUT_LINES = 5000;

const BUILTIN_AGENT_PROMPT = [
  "You are an Alpha subagent.",
  "Complete the delegated assignment independently.",
  "Use tools when needed for grounded repository work.",
  "Do not run project-wide formatters, linters, or tests unless the assignment explicitly asks.",
  "Return a concise final report with changed files, findings, and any verification performed.",
].join("\n");

const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {
    name: "task",
    description: "General-purpose subagent with full Alpha capabilities for delegated multi-step tasks",
    systemPrompt: BUILTIN_AGENT_PROMPT,
    spawns: "*",
    source: "bundled",
  },
  {
    name: "quick_task",
    description: "Low-reasoning subagent for strictly mechanical updates or data collection only",
    systemPrompt: [
      BUILTIN_AGENT_PROMPT,
      "Keep reasoning minimal. Use this role only for mechanical lookup, small edits, and data collection.",
    ].join("\n\n"),
    source: "bundled",
  },
  {
    name: "explore",
    description: "READ-ONLY agent for repository investigation and concise reporting",
    systemPrompt: [
      BUILTIN_AGENT_PROMPT,
      "You are read-only. Do not modify files or execute mutating commands.",
    ].join("\n\n"),
    tools: ["read", "search", "find", "lsp", "todo"],
    source: "bundled",
  },
  {
    name: "reviewer",
    description: "Review agent focused on bugs, regressions, risks, and missing tests",
    systemPrompt: [
      BUILTIN_AGENT_PROMPT,
      "Review from a code-review stance. Lead with actionable findings and file/line references.",
    ].join("\n\n"),
    tools: ["read", "search", "find", "lsp", "todo"],
    source: "bundled",
  },
  {
    name: "plan",
    description: "Planning agent for decomposing work and identifying implementation risks",
    systemPrompt: [
      BUILTIN_AGENT_PROMPT,
      "Produce a concrete implementation plan. Do not edit files.",
    ].join("\n\n"),
    tools: ["read", "search", "find", "lsp", "todo"],
    source: "bundled",
  },
  {
    name: "oracle",
    description: "Deep analysis agent for hard debugging or architecture questions",
    systemPrompt: BUILTIN_AGENT_PROMPT,
    source: "bundled",
  },
];

export function parseTaskInput(args: string): TaskParams {
  const text = args.trim();
  if (!text) throw new Error("task requires JSON input.");
  if (!text.startsWith("{")) {
    return { agent: "task", assignment: text };
  }
  return repairTaskParams(JSON.parse(text) as TaskParams);
}

export function repairTaskParams(params: TaskParams): TaskParams {
  const repaired: TaskParams = { ...params };
  if (typeof repaired.assignment === "string") repaired.assignment = maybeDecodeJsonString(repaired.assignment);
  if (typeof repaired.context === "string") repaired.context = maybeDecodeJsonString(repaired.context);
  if (Array.isArray(repaired.tasks)) {
    repaired.tasks = repaired.tasks.map((task) => ({
      ...task,
      assignment: typeof task.assignment === "string" ? maybeDecodeJsonString(task.assignment) : task.assignment,
    }));
  }
  return repaired;
}

export function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
  if ((params as Record<string, unknown>).schema !== undefined) {
    return "The task tool does not accept `schema`. Rely on the selected agent definition's output schema; ad-hoc structured output is host-limited in Alpha.";
  }
  if (!batchEnabled) {
    const disallowed = (["tasks", "context"] as const).filter((field) => params[field] !== undefined);
    if (disallowed.length > 0) {
      return `task.batch is disabled, so the task tool does not accept ${disallowed.map((field) => `\`${field}\``).join(" or ")}. Spawn one agent per call with \`assignment\`.`;
    }
  }
  return undefined;
}

export function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
  const agent = typeof params.agent === "string" ? params.agent.trim() : "";
  if (!agent) return "Missing `agent`. Provide an agent type to spawn.";

  const hasAssignment = typeof params.assignment === "string" && params.assignment.trim() !== "";
  if (batchEnabled && params.tasks !== undefined) {
    if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
      return "Missing `tasks`. Provide at least one task item ({ id?, description?, assignment }).";
    }
    if (hasAssignment) {
      return "Top-level `assignment` is not part of the batch shape. Put the work in `tasks[]` items.";
    }
    for (let index = 0; index < params.tasks.length; index++) {
      const task = params.tasks[index];
      if (!task || typeof task.assignment !== "string" || task.assignment.trim() === "") {
        return `Task ${index + 1}${task?.id ? ` (\`${task.id}\`)` : ""} is missing \`assignment\`. Every task needs complete, self-contained instructions.`;
      }
    }
    const seen = new Map<string, string>();
    for (const task of params.tasks) {
      const id = task.id?.trim();
      if (!id) continue;
      const key = id.toLowerCase();
      const existing = seen.get(key);
      if (existing !== undefined) {
        return `Duplicate task id ${existing === id ? `\`${id}\`` : `\`${existing}\` / \`${id}\``}. Provided ids must be unique within a call (case-insensitive).`;
      }
      seen.set(key, id);
    }
    if (typeof params.context !== "string" || params.context.trim() === "") {
      return "Missing `context`. Provide the shared background for this batch: goal, constraints, and shared contract.";
    }
    return undefined;
  }

  if (!hasAssignment) {
    return batchEnabled
      ? "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`."
      : "Missing `assignment`. Provide complete, self-contained instructions for the agent.";
  }
  return undefined;
}

export function resolveSpawnItems(params: TaskParams): TaskItem[] {
  if (Array.isArray(params.tasks) && params.tasks.length > 0) return params.tasks;
  return [{ id: params.id, description: params.description, assignment: params.assignment, isolated: params.isolated }];
}

export function spawnParamsFor(params: TaskParams, item: TaskItem): TaskParams {
  const spawn: TaskParams = { agent: params.agent };
  if (item.id !== undefined) spawn.id = item.id;
  if (item.description !== undefined) spawn.description = item.description;
  if (item.assignment !== undefined) spawn.assignment = item.assignment;
  if (params.context !== undefined) spawn.context = params.context;
  if (item.isolated !== undefined) {
    spawn.isolated = item.isolated;
  } else if ("isolated" in params) {
    spawn.isolated = params.isolated;
  }
  return spawn;
}

export { DEFAULT_BATCH_ENABLED, DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_LINES };

export function formatTaskModeError(text: string): string {
  return text;
}

export async function discoverAgents(cwd: string = process.cwd(), home: string = os.homedir()): Promise<DiscoveryResult> {
  const resolvedCwd = path.resolve(cwd);
  const projectDirs = await findNearestProjectAgentDirs(resolvedCwd);
  const userDir = path.join(home, ".omp", "agent", "agents");

  const orderedDirs: Array<{ dir: string; source: AgentSource }> = [];
  if (projectDirs[0]) orderedDirs.push({ dir: projectDirs[0], source: "project" });
  orderedDirs.push({ dir: userDir, source: "user" });

  const seen = new Set<string>();
  const loaded: AgentDefinition[] = [];
  for (const entry of orderedDirs) {
    for (const agent of await loadAgentsFromDir(entry.dir, entry.source)) {
      if (seen.has(agent.name)) continue;
      seen.add(agent.name);
      loaded.push(agent);
    }
  }

  for (const agent of BUILTIN_AGENTS) {
    if (seen.has(agent.name)) continue;
    seen.add(agent.name);
    loaded.push({ ...agent });
  }

  return {
    agents: loaded,
    projectAgentsDir: projectDirs[0] ?? null,
  };
}

export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
  return agents.find((agent) => agent.name === name);
}

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
  const readOnlyTools = new Set(["read", "search", "find", "lsp", "web_search", "todo", "job", "recall", "reflect", "retain", "render_mermaid", "inspect_image", "search_tool_bm25"]);
  return !!agent.tools?.length && agent.tools.every((tool) => readOnlyTools.has(tool));
}

export function renderTaskDescription(agents: AgentDefinition[], options: { asyncEnabled: boolean; batchEnabled: boolean; maxConcurrency: number }): string {
  const mode = options.asyncEnabled
    ? options.batchEnabled
      ? "Spawns subagents to work in the background, one per tasks[] item."
      : "Spawns one subagent per call to work in the background."
    : options.batchEnabled
      ? "Runs subagents synchronously, one per tasks[] item."
      : "Runs one subagent synchronously per call.";
  const agentLines = agents.map((agent) => `# ${agent.name}${isReadOnlyAgent(agent) ? " - READ-ONLY (no edit/write/exec tools)" : ""}\n${agent.description}`).join("\n");
  return [
    mode,
    `Concurrency is bounded at ${options.maxConcurrency} running subagents per session.`,
    "Subagents have no conversation history; every fact, file path, and acceptance criterion must be explicit in context or assignment.",
    "Subagents must skip project-wide gates, formatters, and tests unless explicitly assigned.",
    "Alpha host limitations: isolated git worktrees, IRC keep-alive, agent:// URLs, and raw OMP TUI lifecycle events are not available in the VS Code chat participant.",
    "<agents>",
    agentLines,
    "</agents>",
  ].join("\n\n");
}

export function renderSubagentPrompt(agent: AgentDefinition, params: TaskParams): string {
  const assignment = (params.assignment ?? "").trim();
  const context = (params.context ?? "").trim();
  return [
    "# Agent",
    agent.systemPrompt.trim(),
    "",
    context ? `# Shared Context\n${context}\n` : undefined,
    "# Assignment",
    assignment,
    "",
    "# Output",
    "Return only the final result for the parent. Include changed files, findings, blockers, and verification performed.",
  ].filter((part): part is string => typeof part === "string").join("\n");
}

export function allocateTaskId(requested: string | undefined, existingIds: ReadonlySet<string>): string {
  const base = sanitizeTaskId(requested) || `Task${Date.now().toString(36)}`;
  if (!existingIds.has(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base}${index}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${base}${Math.random().toString(36).slice(2, 8)}`;
}

export function truncateTaskOutput(output: string, maxBytes = DEFAULT_MAX_OUTPUT_BYTES, maxLines = DEFAULT_MAX_OUTPUT_LINES): { output: string; truncated: boolean } {
  const lines = output.split(/\r?\n/);
  let truncated = false;
  let visible = lines;
  if (lines.length > maxLines) {
    visible = lines.slice(0, maxLines);
    truncated = true;
  }
  let text = visible.join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    text = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
    truncated = true;
  }
  return { output: text, truncated };
}

export function renderTaskSummary(result: SingleResult): string {
  const status = result.aborted ? "cancelled" : result.exitCode === 0 ? "completed" : `failed (exit ${result.exitCode})`;
  const output = result.output.trim() || result.stderr.trim() || (result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)");
  return [
    `Task ${result.id} (${result.agent}) ${status} in ${formatDuration(result.durationMs)}.`,
    result.description ? `Description: ${result.description}` : undefined,
    result.truncated ? "Output was truncated; full output is stored as an artifact." : undefined,
    "",
    output,
    result.outputPath ? `\nOutput: ${result.outputPath}` : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function renderCombinedTaskResult(results: SingleResult[], totalDurationMs: number): string {
  if (!results.length) return "No task results.";
  const failed = results.filter((result) => result.exitCode !== 0 || result.aborted);
  const lines = [
    `Task batch finished: ${results.length - failed.length}/${results.length} completed in ${formatDuration(totalDurationMs)}.`,
    "",
  ];
  for (const result of results) {
    lines.push(renderTaskSummary(result), "");
  }
  return lines.join("\n").trimEnd();
}

function maybeDecodeJsonString(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("\"") && trimmed.endsWith("\""))) return value;
  try {
    const decoded = JSON.parse(trimmed);
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}

async function findNearestProjectAgentDirs(cwd: string): Promise<string[]> {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".omp", "agents");
    if (await pathExists(candidate)) dirs.push(candidate);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const agents: AgentDefinition[] = [];
  for (const entry of entries.filter((item) => (item.isFile() || item.isSymbolicLink()) && item.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(dir, entry.name);
    try {
      agents.push(parseAgent(filePath, await fs.readFile(filePath, "utf8"), source));
    } catch {
      // Match OMP's warning-level behavior for discovered files: bad custom agents do not break the tool.
    }
  }
  return agents;
}

export function parseAgent(filePath: string, content: string, source: AgentSource): AgentDefinition {
  const { frontmatter, body } = parseFrontmatter(content);
  const name = stringField(frontmatter, "name") ?? path.basename(filePath, ".md");
  const description = stringField(frontmatter, "description") ?? "Custom Alpha subagent";
  return {
    name,
    description,
    systemPrompt: body.trim() || BUILTIN_AGENT_PROMPT,
    tools: stringArrayField(frontmatter, "tools"),
    spawns: spawnsField(frontmatter),
    model: stringArrayField(frontmatter, "model"),
    thinkingLevel: stringField(frontmatter, "thinkingLevel"),
    output: frontmatter.output,
    blocking: booleanField(frontmatter, "blocking"),
    source,
    filePath,
  };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: content };
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  return { frontmatter: parseSimpleYaml(raw), body };
}

function parseSimpleYaml(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf(":");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!key) continue;
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value.slice(1, -1).split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
    } else {
      out[key] = stripQuotes(value);
    }
  }
  return out;
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayField(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return undefined;
}

function spawnsField(input: Record<string, unknown>): string[] | "*" | undefined {
  const value = input.spawns;
  if (value === "*") return "*";
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return undefined;
}

function booleanField(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeTaskId(input: string | undefined): string {
  return (input ?? "").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 32);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
