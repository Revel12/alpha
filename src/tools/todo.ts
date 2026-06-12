import type { TodoItem, TodoStatus, ToolDefinition } from "../types";

const validStatuses = new Set<TodoStatus>(["pending", "in_progress", "completed", "abandoned"]);

export const todoTool: ToolDefinition = {
  name: "todo",
  summary: "Manage a local OMP-style todo list. Examples: todo add item, todo done item, todo list",
  async run(args, ctx) {
    const text = args.trim();
    const [op, ...rest] = text.split(/\s+/);
    const value = rest.join(" ").trim();
    const items = ctx.todos.list();

    if (!op || op === "list") {
      return { markdown: renderTodos(items) };
    }

    if (op === "add") {
      if (!value) throw new Error("todo add requires text.");
      ctx.todos.set([...items, { content: value, status: "pending" }]);
      return { markdown: renderTodos(ctx.todos.list()) };
    }

    if (validStatuses.has(op as TodoStatus)) {
      if (!value) throw new Error(`todo ${op} requires text to match.`);
      const updated = items.map((item) => item.content.includes(value) ? { ...item, status: op as TodoStatus } : item);
      ctx.todos.set(updated);
      return { markdown: renderTodos(updated) };
    }

    throw new Error("Unknown todo operation. Use list, add, pending, in_progress, completed, or abandoned.");
  },
};

function renderTodos(items: TodoItem[]): string {
  if (!items.length) return "No todos.";
  return items.map((item) => `- [${marker(item.status)}] ${item.content}`).join("\n");
}

function marker(status: TodoStatus): string {
  if (status === "completed") return "x";
  if (status === "in_progress") return ">";
  if (status === "abandoned") return "-";
  return " ";
}
