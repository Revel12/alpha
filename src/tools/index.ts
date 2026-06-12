import type { ToolDefinition } from "../types";
import { diffTool } from "./diff";
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
  searchTool,
  findTool,
  diffTool,
  editTool,
  writeTool,
  resolveTool,
  todoTool,
  reviewTool,
];

export function toolHelp(): string {
  return tools.map((tool) => `- \`${tool.name}\`: ${tool.summary}`).join("\n");
}
