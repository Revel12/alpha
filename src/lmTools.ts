import * as vscode from "vscode";
import type { AlphaContext, ToolResult } from "./types";
import { tools } from "./tools";

const MAX_TOOL_ROUNDS = 8;

interface ToolInputSpec {
  name: string;
  description: string;
  inputSchema: object;
  toArgs(input: object): string;
}

const stringProperty = (description: string): object => ({ type: "string", description });

const alphaToolSpecs: ToolInputSpec[] = [
  {
    name: "read",
    description: "Read a workspace file, the active editor, or selection and return hash-anchored text.",
    inputSchema: objectSchema({ path: stringProperty("Workspace-relative path to read. Use active for the active editor.") }, []),
    toArgs: (input) => optionalString(input, "path") || "active",
  },
  {
    name: "search",
    description: "Search text across workspace files.",
    inputSchema: objectSchema({ query: stringProperty("Text to search for across the workspace.") }, ["query"]),
    toArgs: (input) => requiredString(input, "query"),
  },
  {
    name: "find",
    description: "Find workspace files by glob.",
    inputSchema: objectSchema({ glob: stringProperty("Glob pattern, such as src/**/*.ts.") }, []),
    toArgs: (input) => optionalString(input, "glob") || "**/*",
  },
  {
    name: "diff",
    description: "Show changed files and git diff stats for the workspace.",
    inputSchema: objectSchema({}, []),
    toArgs: () => "",
  },
  {
    name: "edit",
    description: "Apply OMP-style hashline edits after validating the file hash and target range.",
    inputSchema: objectSchema({ patch: stringProperty("Hashline edit patch to apply.") }, ["patch"]),
    toArgs: (input) => requiredString(input, "patch"),
  },
  {
    name: "write",
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

export const alphaLanguageModelTools: vscode.LanguageModelChatTool[] = alphaToolSpecs.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

export function toolCallingSystemPrompt(): string {
  return [
    "You are Alpha, an OMP-style local coding harness inside VS Code.",
    "Use the provided local tools whenever workspace context, file search, file edits, diffs, or todos are needed.",
    "The available tools are private to this chat participant and intentionally mirror OMP-style names.",
    "For edits, read the target file first and use the returned hash anchor in the hashline edit patch.",
    "Keep final answers concise and implementation-focused. Summarize tool results instead of dumping large outputs unless the user asks for raw output.",
  ].join("\n");
}

export async function answerWithAlphaTools(prompt: string, ctx: AlphaContext): Promise<void> {
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(toolCallingSystemPrompt()),
    vscode.LanguageModelChatMessage.User(prompt),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await ctx.request.model.sendRequest(
      messages,
      {
        tools: alphaLanguageModelTools,
        toolMode: vscode.LanguageModelChatToolMode.Auto,
      },
      ctx.token,
    );

    const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        assistantParts.push(chunk);
        ctx.stream.markdown(chunk.value);
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        assistantParts.push(chunk);
        toolCalls.push(chunk);
      }
    }

    if (!toolCalls.length) return;

    if (assistantParts.length) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    }

    for (const call of toolCalls) {
      const result = await runAlphaLanguageModelTool(call, ctx);
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result.markdown)]),
        ]),
      );
    }
  }

  ctx.stream.markdown("\n\nAlpha stopped after too many tool-call rounds.");
}

async function runAlphaLanguageModelTool(call: vscode.LanguageModelToolCallPart, ctx: AlphaContext): Promise<ToolResult> {
  const spec = alphaToolSpecs.find((candidate) => candidate.name === call.name);
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!spec || !tool) {
    return { markdown: `Unknown Alpha tool: ${call.name}` };
  }

  try {
    return await tool.run(spec.toArgs(call.input), ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { markdown: `Alpha tool ${tool.name} failed: ${message}` };
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
