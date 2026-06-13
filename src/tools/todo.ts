import type { TodoCompletionTransition, TodoItem, TodoPhase, TodoStatus, ToolDefinition } from "../types";

export type TodoOpName = "init" | "start" | "done" | "rm" | "drop" | "append" | "view";

export interface TodoInitEntry {
  phase: string;
  items: string[];
}

export interface TodoOpEntry {
  op: TodoOpName;
  list?: TodoInitEntry[];
  task?: string;
  phase?: string;
  items?: string[];
}

export interface TodoParams {
  ops: TodoOpEntry[];
}

const TODO_OPS = new Set<TodoOpName>(["init", "start", "done", "rm", "drop", "append", "view"]);
const TODO_DESCRIPTION_MIN_OVERLAP = 6;

export const todoTool: ToolDefinition = {
  name: "todo",
  summary: "Manage an OMP-style phased todo list using init/start/done/drop/rm/append/view operations.",
  async run(args, ctx) {
    const params = parseTodoInput(args);
    const previous = clonePhases(ctx.todos.list());
    const readOnly = params.ops.every((entry) => entry.op === "view");

    if (readOnly) {
      return { markdown: formatSummary(previous, [], true) };
    }

    const { phases: updated, errors } = applyTodoOpsToPhases(previous, params.ops);
    const failed = errors.length > 0;
    const effective = failed ? previous : updated;
    if (!failed) {
      ctx.todos.set(updated);
    }

    return { markdown: formatSummary(effective, errors, false) };
  },
};

export function parseTodoInput(args: string): TodoParams {
  const text = args.trim();
  if (!text) return { ops: [{ op: "view" }] };

  if (text.startsWith("{") || text.startsWith("[")) {
    const raw = JSON.parse(text) as unknown;
    if (Array.isArray(raw)) {
      return validateTodoParams({ ops: raw });
    }
    return validateTodoParams(raw);
  }

  return parseLegacyTodoInput(text);
}

export function applyTodoOpsToPhases(
  currentPhases: TodoPhase[],
  ops: TodoOpEntry[],
): { phases: TodoPhase[]; errors: string[]; completedTasks: TodoCompletionTransition[] } {
  const previous = clonePhases(currentPhases);
  const errors: string[] = [];
  let next = clonePhases(currentPhases);
  for (const entry of ops) {
    next = applyEntry(next, entry, errors);
  }
  normalizeInProgressTask(next);
  return {
    phases: next,
    errors,
    completedTasks: errors.length > 0 ? [] : getCompletionTransitions(previous, next),
  };
}

export function phasesToMarkdown(phases: TodoPhase[]): string {
  if (phases.length === 0) return "# Todos\n";
  const out: string[] = [];
  for (const [index, phase] of phases.entries()) {
    if (index > 0) out.push("");
    out.push(`# ${phase.name}`);
    for (const task of phase.tasks) {
      out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}`);
    }
  }
  return `${out.join("\n")}\n`;
}

export function markdownToPhases(markdown: string): { phases: TodoPhase[]; errors: string[] } {
  const phases: TodoPhase[] = [];
  const errors: string[] = [];
  let currentPhase: TodoPhase | undefined;

  const lines = markdown.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const trimmed = lines[lineIndex].trim();
    if (!trimmed) continue;

    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
    if (heading) {
      currentPhase = { name: heading[1].trim(), tasks: [] };
      phases.push(currentPhase);
      continue;
    }

    const task = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/.exec(trimmed);
    if (task) {
      if (!currentPhase) {
        currentPhase = { name: "Todos", tasks: [] };
        phases.push(currentPhase);
      }
      const status = MARKER_TO_STATUS[task[1]];
      if (!status) {
        errors.push(`Line ${lineIndex + 1}: unknown status marker "[${task[1]}]" (use [ ], [x], [/], [-])`);
        continue;
      }
      currentPhase.tasks.push({ content: task[2].trim(), status });
      continue;
    }

    errors.push(`Line ${lineIndex + 1}: unrecognized syntax "${trimmed}"`);
  }

  normalizeInProgressTask(phases);
  return { phases, errors };
}

export function selectStickyTodoWindow(
  tasks: TodoItem[],
  maxVisible = 5,
): { visible: TodoItem[]; hiddenOpenCount: number } {
  const openTasks = tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
  if (openTasks.length > 0) {
    const visible = openTasks.slice(0, maxVisible);
    return { visible, hiddenOpenCount: openTasks.length - visible.length };
  }
  const start = Math.max(0, tasks.length - maxVisible);
  return { visible: tasks.slice(start), hiddenOpenCount: 0 };
}

export function todoMatchesAnyDescription(content: string, descriptions: readonly string[]): boolean {
  const target = normalizeForTodoMatch(content);
  if (!target) return false;
  for (const description of descriptions) {
    const candidate = normalizeForTodoMatch(description);
    if (!candidate) continue;
    if (candidate === target) return true;
    if (target.length >= TODO_DESCRIPTION_MIN_OVERLAP && candidate.includes(target)) return true;
    if (candidate.length >= TODO_DESCRIPTION_MIN_OVERLAP && target.includes(candidate)) return true;
  }
  return false;
}

function validateTodoParams(raw: unknown): TodoParams {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { ops?: unknown }).ops)) {
    throw new Error("todo expects JSON object with ops array.");
  }
  const ops = (raw as { ops: unknown[] }).ops.map(validateTodoOp);
  if (ops.length === 0) throw new Error("todo ops must contain at least one operation.");
  return { ops };
}

function validateTodoOp(raw: unknown): TodoOpEntry {
  if (!raw || typeof raw !== "object") throw new Error("todo op must be an object.");
  const input = raw as Record<string, unknown>;
  if (typeof input.op !== "string" || !TODO_OPS.has(input.op as TodoOpName)) {
    throw new Error("todo op must be one of init, start, done, rm, drop, append, view.");
  }
  return {
    op: input.op as TodoOpName,
    list: validateInitList(input.list),
    task: optionalString(input.task),
    phase: optionalString(input.phase),
    items: validateItems(input.items),
  };
}

function validateInitList(value: unknown): TodoInitEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("todo init list must be an array.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("todo init list entries must be objects.");
    const input = entry as Record<string, unknown>;
    const phase = optionalString(input.phase);
    if (!phase) throw new Error("todo init list entry requires phase.");
    const items = validateItems(input.items);
    if (!items?.length) throw new Error("todo init list entry requires non-empty items.");
    return { phase, items };
  });
}

function validateItems(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("todo items must be an array.");
  const items = value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error("todo items must be non-empty strings.");
    }
    return item.trim();
  });
  if (items.length === 0) throw new Error("todo items must contain at least one item.");
  return items;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseLegacyTodoInput(text: string): TodoParams {
  const [rawOp, ...rest] = text.split(/\s+/);
  const value = rest.join(" ").trim();
  switch (rawOp) {
    case "list":
    case "view":
      return { ops: [{ op: "view" }] };
    case "add":
      if (!value) throw new Error("todo add requires text.");
      return { ops: [{ op: "append", phase: "Todos", items: [value] }] };
    case "done":
    case "completed":
      if (!value) throw new Error(`todo ${rawOp} requires text to match.`);
      return { ops: [{ op: "done", task: value }] };
    case "drop":
    case "abandoned":
      if (!value) throw new Error(`todo ${rawOp} requires text to match.`);
      return { ops: [{ op: "drop", task: value }] };
    case "start":
    case "in_progress":
      if (!value) throw new Error(`todo ${rawOp} requires text to match.`);
      return { ops: [{ op: "start", task: value }] };
    default:
      throw new Error("Unknown todo operation. Use init, start, done, drop, rm, append, or view.");
  }
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoPhase[] {
  switch (entry.op) {
    case "init":
      return initPhases(entry, errors);
    case "start":
      return startTask(phases, entry, errors);
    case "done":
      for (const task of getTaskTargets(phases, entry, errors)) task.status = "completed";
      return phases;
    case "drop":
      for (const task of getTaskTargets(phases, entry, errors)) task.status = "abandoned";
      return phases;
    case "rm":
      return removeTasks(phases, entry, errors);
    case "append":
      return appendItems(phases, entry, errors);
    case "view":
      return phases;
  }
}

function initPhases(entry: TodoOpEntry, errors: string[]): TodoPhase[] {
  if (!entry.list) {
    errors.push("Missing list for init operation");
    return [];
  }

  const seenPhases = new Set<string>();
  const seenTasks = new Set<string>();
  for (const listEntry of entry.list) {
    if (seenPhases.has(listEntry.phase)) {
      errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
    }
    seenPhases.add(listEntry.phase);
    for (const content of listEntry.items) {
      if (seenTasks.has(content)) {
        errors.push(`Duplicate task "${content}" in init list`);
      }
      seenTasks.add(content);
    }
  }

  return entry.list.map((listEntry) => ({
    name: listEntry.phase,
    tasks: listEntry.items.map((content) => ({ content, status: "pending" })),
  }));
}

function startTask(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoPhase[] {
  const hit = resolveTaskOrError(phases, entry.task, errors);
  if (!hit) return phases;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status === "in_progress" && task !== hit.task) {
        task.status = "pending";
      }
    }
  }
  hit.task.status = "in_progress";
  return phases;
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoPhase[] {
  if (!entry.phase) {
    errors.push("Missing phase name for append operation");
    return phases;
  }
  if (!entry.items?.length) {
    errors.push("Missing items for append operation");
    return phases;
  }

  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const content of entry.items) {
    if (seen.has(content) || findTaskByContent(phases, content)) {
      errors.push(`Task "${content}" already exists`);
      hasDuplicate = true;
    }
    seen.add(content);
  }
  if (hasDuplicate) return phases;

  let phase = findPhaseByName(phases, entry.phase);
  if (!phase) {
    phase = { name: entry.phase, tasks: [] };
    phases.push(phase);
  }
  for (const content of entry.items) {
    phase.tasks.push({ content, status: "pending" });
  }
  return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoPhase[] {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors);
    if (!hit) return phases;
    hit.phase.tasks = hit.phase.tasks.filter((candidate) => candidate !== hit.task);
    return phases;
  }

  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    if (!phase) return phases;
    phase.tasks = [];
    return phases;
  }

  for (const phase of phases) {
    phase.tasks = [];
  }
  return phases;
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoItem[] {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors);
    return hit ? [hit.task] : [];
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    return phase ? [...phase.tasks] : [];
  }
  return phases.flatMap((phase) => phase.tasks);
}

function resolveTaskOrError(
  phases: TodoPhase[],
  content: string | undefined,
  errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
  if (!content) {
    errors.push("Missing task content");
    return undefined;
  }
  const hit = findTaskByContent(phases, content);
  if (hit) return hit;

  if (/^task-\d+$/.test(content)) {
    errors.push(`Task "${content}" not found. Tasks are referenced by content, not by IDs; pass the task's full text from the previous result.`);
  } else {
    const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
    const hint = totalTasks === 0 ? " (todo list is empty; was it replaced or not yet created?)" : "";
    errors.push(`Task "${content}" not found${hint}`);
  }
  return undefined;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
  if (!name) {
    errors.push("Missing phase name");
    return undefined;
  }
  const phase = findPhaseByName(phases, name);
  if (!phase) errors.push(`Phase "${name}" not found`);
  return phase;
}

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((candidate) => candidate.content === content);
    if (task) return { task, phase };
  }
  return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
  return phases.find((phase) => phase.name === name);
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
  const orderedTasks = phases.flatMap((phase) => phase.tasks);
  if (orderedTasks.length === 0) return;

  const inProgressTasks = orderedTasks.filter((task) => task.status === "in_progress");
  if (inProgressTasks.length > 1) {
    for (const task of inProgressTasks.slice(1)) {
      task.status = "pending";
    }
  }

  if (inProgressTasks.length > 0) return;

  const firstPendingTask = orderedTasks.find((task) => task.status === "pending");
  if (firstPendingTask) firstPendingTask.status = "in_progress";
}

function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
  const previousStatuses = new Map<string, TodoStatus>();
  for (const phase of previous) {
    for (const task of phase.tasks) {
      previousStatuses.set(todoTransitionKey(phase.name, task.content), task.status);
    }
  }

  const transitions: TodoCompletionTransition[] = [];
  for (const phase of updated) {
    for (const task of phase.tasks) {
      if (task.status !== "completed") continue;
      const previousStatus = previousStatuses.get(todoTransitionKey(phase.name, task.content));
      if (previousStatus && previousStatus !== "completed") {
        transitions.push({ phase: phase.name, content: task.content });
      }
    }
  }
  return transitions;
}

function todoTransitionKey(phase: string, content: string): string {
  return `${phase}\u0000${content}`;
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
  return phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => ({ content: task.content, status: task.status })),
  }));
}

function formatSummary(phases: TodoPhase[], errors: string[], readOnly: boolean): string {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) {
    if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
    return readOnly ? "Todo list is empty." : "Todo list cleared.";
  }

  const remainingByPhase = phases
    .map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
    }))
    .filter((phase) => phase.tasks.length > 0);
  const remainingTasks = remainingByPhase.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phase: phase.name })));

  let currentIndex = phases.findIndex((phase) =>
    phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress"),
  );
  if (currentIndex === -1) currentIndex = phases.length - 1;
  const current = phases[currentIndex];
  const closed = current.tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;

  const lines: string[] = [];
  if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
  if (remainingTasks.length === 0) {
    lines.push("Remaining items: none.");
  } else {
    lines.push(`Remaining items (${remainingTasks.length}):`);
    for (const task of remainingTasks) {
      lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
    }
  }
  lines.push(`Phase ${currentIndex + 1}/${phases.length} "${current.name}" - ${closed}/${current.tasks.length} tasks complete`);
  for (const phase of phases) {
    lines.push(`  ${phase.name}:`);
    for (const task of phase.tasks) {
      lines.push(`    ${statusSymbol(task.status)} ${task.content}`);
    }
  }
  return lines.join("\n");
}

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
  pending: " ",
  in_progress: "/",
  completed: "x",
  abandoned: "-",
};

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
  " ": "pending",
  "": "pending",
  x: "completed",
  X: "completed",
  "/": "in_progress",
  ">": "in_progress",
  "-": "abandoned",
  "~": "abandoned",
};

function statusSymbol(status: TodoStatus): string {
  if (status === "completed") return "x";
  if (status === "in_progress") return ">";
  if (status === "abandoned") return "-";
  return "o";
}

function normalizeForTodoMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
