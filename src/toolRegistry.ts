import type * as vscode from "vscode";
import type { AlphaContext, ToolDefinition, ToolResult } from "./types";

export type AlphaToolVisibility = "public" | "hidden";
export type AlphaToolLoadMode = "essential" | "discoverable";

type ToolLoader = () => Promise<ToolDefinition>;

export interface AlphaToolRegistration {
  name: string;
  visibility: AlphaToolVisibility;
  loadMode: AlphaToolLoadMode;
  description: string;
  inputSchema: object;
  enabled(ctx?: AlphaContext): boolean;
  loadTool: ToolLoader;
  toArgs(input: object): string;
}

export interface AlphaToolSelection {
  forceTools?: readonly string[];
  includeDiscoverable?: boolean;
  onlyForced?: boolean;
  ctx?: AlphaContext;
}

export const DEFAULT_ESSENTIAL_TOOL_NAMES: readonly string[] = ["read", "edit"] as const;

const stringProperty = (description: string): object => ({ type: "string", description });
const alwaysEnabled = (): boolean => true;

export const alphaToolRegistry: readonly AlphaToolRegistration[] = [
  {
    name: "read",
    visibility: "public",
    loadMode: "essential",
    description: "Read a workspace file, directory, active editor, or selection and return OMP-style [path#TAG] text.",
    inputSchema: objectSchema({ path: stringProperty("Workspace-relative path to read. Use active for the active editor.") }, []),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/read")).readTool,
    toArgs: (input) => optionalString(input, "path") || "active",
  },
  {
    name: "search",
    visibility: "public",
    loadMode: "discoverable",
    description: "Search text across workspace files.",
    inputSchema: objectSchema({ query: stringProperty("Text to search for across the workspace.") }, ["query"]),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/search")).searchTool,
    toArgs: (input) => requiredString(input, "query"),
  },
  {
    name: "find",
    visibility: "public",
    loadMode: "discoverable",
    description: "Find workspace files by glob.",
    inputSchema: objectSchema({ glob: stringProperty("Glob pattern, such as src/**/*.ts.") }, []),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/find")).findTool,
    toArgs: (input) => optionalString(input, "glob") || "**/*",
  },
  {
    name: "diff",
    visibility: "public",
    loadMode: "discoverable",
    description: "Show changed files and git diff stats for the workspace.",
    inputSchema: objectSchema({}, []),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/diff")).diffTool,
    toArgs: () => "",
  },
  {
    name: "edit",
    visibility: "public",
    loadMode: "essential",
    description: "Default tool for modifying existing files. Applies OMP-style hashline edits after validating the file tag and target range.",
    inputSchema: objectSchema({ input: stringProperty("OMP-style hashline edit input.") }, ["input"]),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/edit")).editTool,
    toArgs: (input) => requiredString(input, "input"),
  },
  {
    name: "write",
    visibility: "public",
    loadMode: "discoverable",
    description: "Create a new file or intentionally overwrite an entire file. Do not use for routine edits to existing files; use edit instead.",
    inputSchema: objectSchema(
      {
        path: stringProperty("Workspace-relative file path to write."),
        content: stringProperty("Complete file content to write."),
      },
      ["path", "content"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/write")).writeTool,
    toArgs: (input) => `${requiredString(input, "path")}\n${requiredString(input, "content")}`,
  },
  {
    name: "resolve",
    visibility: "hidden",
    loadMode: "discoverable",
    description: "Apply or discard the pending Alpha preview action.",
    inputSchema: objectSchema(
      {
        action: { type: "string", enum: ["apply", "discard"], description: "Resolution action for pending preview work." },
        reason: stringProperty("Brief reason for applying or discarding the pending work."),
        extra: { type: "object", description: "Optional workflow-specific resolution data." },
      },
      ["action", "reason"],
    ),
    enabled: (ctx) => !ctx || ctx.pendingEdits.list().length > 0,
    loadTool: async () => (await import("./tools/resolve")).resolveTool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "todo",
    visibility: "public",
    loadMode: "discoverable",
    description: "Manage the local Alpha todo list.",
    inputSchema: objectSchema(
      {
        op: {
          type: "string",
          enum: ["list", "add", "pending", "in_progress", "completed", "abandoned"],
          description: "Todo operation.",
        },
        text: stringProperty("Todo text to add or match."),
      },
      [],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/todo")).todoTool,
    toArgs: (input) => {
      const op = optionalString(input, "op") || "list";
      const text = optionalString(input, "text");
      return text ? `${op} ${text}` : op;
    },
  },
];

export function getAdvertisedAlphaTools(selection: AlphaToolSelection = {}): AlphaToolRegistration[] {
  const forced = new Set(selection.forceTools ?? []);
  const includeDiscoverable = selection.includeDiscoverable ?? true;

  return alphaToolRegistry.filter((tool) => {
    if (!tool.enabled(selection.ctx)) return false;
    if (selection.onlyForced) return forced.has(tool.name);
    if (forced.has(tool.name)) return true;
    if (tool.visibility !== "public") return false;
    if (tool.loadMode === "essential") return true;
    return includeDiscoverable;
  });
}

export function getAdvertisedAlphaLanguageModelTools(selection: AlphaToolSelection = {}): vscode.LanguageModelChatTool[] {
  return getAdvertisedAlphaTools(selection).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function getAlphaToolRegistration(name: string, ctx?: AlphaContext): AlphaToolRegistration | undefined {
  return alphaToolRegistry.find((tool) => tool.name === name && tool.enabled(ctx));
}

export function getEssentialAlphaToolNames(): string[] {
  return getAdvertisedAlphaTools({ includeDiscoverable: false }).map((tool) => tool.name);
}

export function getDiscoverableAlphaToolNames(): string[] {
  return alphaToolRegistry.filter((tool) => tool.visibility === "public" && tool.loadMode === "discoverable").map((tool) => tool.name);
}

export async function runRegisteredAlphaTool(
  name: string,
  input: object,
  ctx: AlphaContext,
  activeToolNames: ReadonlySet<string>,
): Promise<ToolResult> {
  if (!activeToolNames.has(name)) {
    return { markdown: `Alpha tool ${name} is not available in this workflow.` };
  }

  const registration = getAlphaToolRegistration(name, ctx);
  if (!registration) {
    return { markdown: `Unknown Alpha tool: ${name}` };
  }

  try {
    const tool = await registration.loadTool();
    return await tool.run(registration.toArgs(input), ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { markdown: `Alpha tool ${name} failed: ${message}` };
  }
}

function objectSchema(properties: Record<string, object>, required: string[]): object {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function optionalString(input: object, key: string): string | undefined {
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function requiredString(input: object, key: string): string {
  const value = optionalString(input, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}
