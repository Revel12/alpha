import type { ToolDefinition } from "../types";
import { askTool } from "./ask";
import { bashTool } from "./bash";
import { bitbucketTool } from "./bitbucket";
import { editTool } from "./edit";
import { evalTool } from "./eval";
import { findTool } from "./find";
import { lspTool } from "./lsp";
import { readTool } from "./read";
import { reportFindingTool } from "./reportFinding";
import { resolveTool } from "./resolve";
import { reviewTool } from "./review";
import { searchTool } from "./search";
import { taskTool } from "./task";
import { todoTool } from "./todo";
import { webSearchTool } from "./webSearch";
import { writeTool } from "./write";
import { yieldTool } from "./yield";

export const tools: ToolDefinition[] = [
  readTool,
  bashTool,
  searchTool,
  findTool,
  webSearchTool,
  askTool,
  editTool,
  writeTool,
  lspTool,
  bitbucketTool,
  taskTool,
  evalTool,
  resolveTool,
  todoTool,
  reviewTool,
  reportFindingTool,
  yieldTool,
];

export function toolHelp(): string {
  return tools.map((tool) => `- \`${tool.name}\`: ${tool.summary}`).join("\n");
}
