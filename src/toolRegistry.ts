import type * as vscode from "vscode";

export type AlphaToolVisibility = "public" | "hidden";

export interface AlphaToolRegistration {
  name: string;
  visibility: AlphaToolVisibility;
  enabled: boolean;
  description: string;
  inputSchema: object;
  toArgs(input: object): string;
}

export interface AlphaToolSelection {
  forceTools?: readonly string[];
}

const stringProperty = (description: string): object => ({ type: "string", description });

export const alphaToolRegistry: readonly AlphaToolRegistration[] = [
  {
    name: "read",
    visibility: "public",
    enabled: true,
    description: "Read a workspace file, the active editor, or selection and return hash-anchored text.",
    inputSchema: objectSchema({ path: stringProperty("Workspace-relative path to read. Use active for the active editor.") }, []),
    toArgs: (input) => optionalString(input, "path") || "active",
  },
  {
    name: "search",
    visibility: "public",
    enabled: true,
    description: "Search text across workspace files.",
    inputSchema: objectSchema({ query: stringProperty("Text to search for across the workspace.") }, ["query"]),
    toArgs: (input) => requiredString(input, "query"),
  },
  {
    name: "find",
    visibility: "public",
    enabled: true,
    description: "Find workspace files by glob.",
    inputSchema: objectSchema({ glob: stringProperty("Glob pattern, such as src/**/*.ts.") }, []),
    toArgs: (input) => optionalString(input, "glob") || "**/*",
  },
  {
    name: "diff",
    visibility: "public",
    enabled: true,
    description: "Show changed files and git diff stats for the workspace.",
    inputSchema: objectSchema({}, []),
    toArgs: () => "",
  },
  {
    name: "edit",
    visibility: "public",
    enabled: true,
    description: "Apply OMP-style hashline edits after validating the file hash and target range.",
    inputSchema: objectSchema({ patch: stringProperty("Hashline edit patch to apply.") }, ["patch"]),
    toArgs: (input) => requiredString(input, "patch"),
  },
  {
    name: "write",
    visibility: "public",
    enabled: true,
    description: "Write a workspace file.",
    inputSchema: objectSchema(
      {
        path: stringProperty("Workspace-relative file path to write."),
        content: stringProperty("Complete file content to write."),
      },
      ["path", "content"],
    ),
    toArgs: (input) => `${requiredString(input, "path")}\n${requiredString(input, "content")}`,
  },
  {
    name: "resolve",
    visibility: "hidden",
    enabled: true,
    description: "List, apply, or clear pending Alpha edits.",
    inputSchema: objectSchema(
      {
        op: { type: "string", enum: ["list", "apply", "clear"], description: "Pending edit operation." },
        id: stringProperty("Pending edit id for apply."),
      },
      [],
    ),
    toArgs: (input) => {
      const op = optionalString(input, "op") || "list";
      const id = optionalString(input, "id");
      return id ? `${op} ${id}` : op;
    },
  },
  {
    name: "todo",
    visibility: "public",
    enabled: true,
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
    toArgs: (input) => {
      const op = optionalString(input, "op") || "list";
      const text = optionalString(input, "text");
      return text ? `${op} ${text}` : op;
    },
  },
];

export function getAdvertisedAlphaTools(selection: AlphaToolSelection = {}): AlphaToolRegistration[] {
  const forced = new Set(selection.forceTools ?? []);
  return alphaToolRegistry.filter((tool) => tool.enabled && (tool.visibility === "public" || forced.has(tool.name)));
}

export function getAdvertisedAlphaLanguageModelTools(selection: AlphaToolSelection = {}): vscode.LanguageModelChatTool[] {
  return getAdvertisedAlphaTools(selection).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function getAlphaToolRegistration(name: string): AlphaToolRegistration | undefined {
  return alphaToolRegistry.find((tool) => tool.name === name && tool.enabled);
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
