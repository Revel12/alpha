import type { ToolDefinition } from "../types";
import { bashTool } from "./bash";
import { editTool } from "./edit";
import { findTool } from "./find";
import { readTool } from "./read";
import { resolveTool } from "./resolve";
import { reviewTool } from "./review";
import { searchTool } from "./search";
import { todoTool } from "./todo";
import { writeTool } from "./write";

export const tools: ToolDefinition[] = [
  readTool,
  bashTool,
  searchTool,
  findTool,
  editTool,
  writeTool,
  resolveTool,
  todoTool,
  reviewTool,
];

export function toolHelp(): string {
  return tools.map((tool) => `- \`${tool.name}\`: ${tool.summary}`).join("\n");
}
