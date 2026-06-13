import type { ToolDefinition } from "../types";
import { bashTool } from "./bash";
import { bitbucketTool } from "./bitbucket";
import { editTool } from "./edit";
import { evalTool } from "./eval";
import { findTool } from "./find";
import { lspTool } from "./lsp";
import { readTool } from "./read";
import { resolveTool } from "./resolve";
import { reviewTool } from "./review";
import { searchTool } from "./search";
import { taskTool } from "./task";
import { todoTool } from "./todo";
import { writeTool } from "./write";

export const tools: ToolDefinition[] = [
  readTool,
  bashTool,
  searchTool,
  findTool,
  editTool,
  writeTool,
  lspTool,
  bitbucketTool,
  taskTool,
  evalTool,
  resolveTool,
  todoTool,
  reviewTool,
];

export function toolHelp(): string {
  return tools.map((tool) => `- \`${tool.name}\`: ${tool.summary}`).join("\n");
}
