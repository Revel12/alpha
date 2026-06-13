import type * as vscode from "vscode";
import { BITBUCKET_OPS } from "./bitbucketCore";
import { schemaKeys } from "./toolDiscoveryCore";
import type { DiscoverableTool } from "./toolDiscoveryCore";
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

export const DEFAULT_ESSENTIAL_TOOL_NAMES: readonly string[] = ["read", "bash", "edit"] as const;

const stringProperty = (description: string): object => ({ type: "string", description });
const alwaysEnabled = (): boolean => true;

export const alphaToolRegistry: readonly AlphaToolRegistration[] = [
  {
    name: "read",
    visibility: "public",
    loadMode: "essential",
    description: "Read files, directories, active editor/selection, internal URLs, web URLs, archive members, SQLite tables/queries, notebooks, documents, images, and structural summaries. Returns OMP-style [path#TAG] text for editable workspace files.",
    inputSchema: objectSchema(
      {
        path: stringProperty(
          "Target to read. Examples: active, selection, src/app.ts, src/app.ts:10-30, src/app.ts:raw, artifact://0, https://example.com, bundle.zip:src/a.ts, data.db:users, data.db?q=select%201, notebook.ipynb, image.png, large.ts:summary.",
        ),
      },
      [],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/read.js")).readTool,
    toArgs: (input) => optionalString(input, "path") || "active",
  },
  {
    name: "bash",
    visibility: "public",
    loadMode: "essential",
    description: "Execute a shell command for build, test, git, package-manager, and other terminal operations. Do not use for file reading, searching, listing, or routine edits.",
    inputSchema: objectSchema(
      {
        command: stringProperty("Shell command to execute."),
        env: { type: "object", additionalProperties: { type: "string" }, description: "Extra environment variables." },
        timeout: { type: "number", description: "Timeout in seconds. Default 300; allowed range 1-3600." },
        cwd: stringProperty("Workspace-relative working directory."),
        pty: { type: "boolean", description: "Run with PTY capture when the host supports it; falls back to a VS Code terminal notice where capture is unavailable." },
        async: { type: "boolean", description: "Run in background. The command is still capped by timeout." },
      },
      ["command"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/bash.js")).bashTool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "search_tool_bm25",
    visibility: "hidden",
    loadMode: "essential",
    description: "Search hidden discoverable tool metadata and activate matching tools for the current Alpha session. Not for repository/file/code search.",
    inputSchema: objectSchema(
      {
        query: stringProperty("Natural-language or keyword tool search query."),
        limit: { type: "number", description: "Maximum matches to return and activate. Default 8." },
      },
      ["query"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/searchToolBm25.js")).searchToolBm25Tool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "search",
    visibility: "public",
    loadMode: "discoverable",
    description: "Search text across workspace files. Uses the OMP-style pattern/paths contract and returns grouped hashline anchors with *line matches, context lines, and artifact spillover for large results.",
    inputSchema: objectSchema(
      {
        pattern: stringProperty("Regex pattern to search for across the workspace."),
        paths: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional file, directory, glob, or array of scopes. Omitted or empty searches the workspace root.",
        },
        i: { type: "boolean", description: "Use case-insensitive matching." },
        gitignore: { type: "boolean", description: "Respect ignore files where the host search provider supports it." },
        skip: { type: "number", description: "Files to skip before collecting results; use to paginate when a prior call hit limits." },
        contextBefore: { type: "number", description: "Context lines before each match. Default follows alpha.search.contextBefore." },
        contextAfter: { type: "number", description: "Context lines after each match. Default follows alpha.search.contextAfter." },
        maxResults: { type: "number", description: "Maximum matches to return before reporting a limit." },
      },
      ["pattern"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/search.js")).searchTool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "find",
    visibility: "public",
    loadMode: "discoverable",
    description: "Find files and directories using OMP-style paths globs. Results are sorted by modification time, grouped by directory, and limited to 200 entries.",
    inputSchema: objectSchema(
      {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Globs, files, or directories including search paths, such as src/**/*.ts or [\"src\", \"test\"].",
        },
        hidden: { type: "boolean", description: "Include hidden files. Defaults to true." },
        gitignore: { type: "boolean", description: "Respect gitignore where the VS Code host search provider supports it. Defaults to true." },
        limit: { type: "number", description: "Maximum results, clamped to 1-200." },
        timeout: { type: "number", description: "Timeout in seconds, clamped to 0.5-60." },
      },
      ["paths"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/find.js")).findTool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "edit",
    visibility: "public",
    loadMode: "essential",
    description: "Default tool for modifying existing files. Applies OMP-style hashline edits after validating the file tag and target range.",
    inputSchema: objectSchema({ input: stringProperty("OMP-style hashline edit input.") }, ["input"]),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/edit.js")).editTool,
    toArgs: (input) => requiredString(input, "input"),
  },
  {
    name: "write",
    visibility: "public",
    loadMode: "discoverable",
    description: "Create or replace complete content for a workspace file, local:// internal URL, archive member, or SQLite row. Do not use for routine edits to existing files; use edit instead.",
    inputSchema: objectSchema(
      {
        path: stringProperty("Target path. Supports workspace files, local:// paths, archive.zip:path/in/archive, data.sqlite:table, and data.sqlite:table:key."),
        content: stringProperty("Complete file content. For SQLite, JSON object inserts/updates a row; empty content with a row key deletes it."),
        overwriteGenerated: { type: "boolean", description: "Allow overwriting generated, lock, build, or vendor files." },
        createDocumentation: { type: "boolean", description: "Allow creating documentation files such as README or Markdown files." },
      },
      ["path", "content"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/write.js")).writeTool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "lsp",
    visibility: "public",
    loadMode: "discoverable",
    description: "Query VS Code language features for diagnostics, definitions, references, hover, symbols, rename, and code actions. Use for symbol-aware operations when language support is available, including VS Code-backed equivalents of OMP's YAML, Terraform, Dockerfile, and Helm LSP defaults.",
    inputSchema: objectSchema(
      {
        action: {
          type: "string",
          enum: [
            "diagnostics",
            "definition",
            "references",
            "hover",
            "symbols",
            "rename",
            "rename_file",
            "code_actions",
            "type_definition",
            "implementation",
            "status",
            "reload",
            "capabilities",
            "request",
          ],
          description: "LSP action to run.",
        },
        file: stringProperty("File path, glob, or '*' for workspace scope where supported."),
        line: { type: "number", description: "1-indexed line number for position-based actions." },
        symbol: stringProperty("Substring on target line; append #N to select the Nth occurrence."),
        query: stringProperty("Symbol search query, code-action selector, or raw method for unsupported request parity."),
        new_name: stringProperty("New symbol name or destination path for rename operations."),
        apply: { type: "boolean", description: "Apply edits for rename/code_actions. Use false to preview rename edits." },
        timeout: { type: "number", description: "Request timeout in seconds, clamped to 5-60 where applicable." },
        payload: stringProperty("JSON-encoded raw request params. Present for OMP schema parity; raw requests are unsupported in Alpha."),
      },
      ["action"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/lsp.js")).lspTool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "bitbucket",
    visibility: "public",
    loadMode: "discoverable",
    description: "Interact with Bitbucket repositories and pull requests. OMP-style repo-host workflow tool replacing GitHub-specific operations; use read/search/find for checked-out code browsing and code search.",
    inputSchema: objectSchema(
      {
        op: { type: "string", enum: BITBUCKET_OPS, description: "Bitbucket operation to run." },
        repo: stringProperty("Repository as PROJECT/repo, workspace/repo, or a Bitbucket URL. Defaults to git remote origin."),
        baseUrl: stringProperty("Bitbucket Server/Data Center base URL. Defaults to alpha.bitbucket.baseUrl, remote host, or bitbucket.org."),
        project: stringProperty("Bitbucket Server project key."),
        workspace: stringProperty("Bitbucket Cloud workspace."),
        slug: stringProperty("Repository slug."),
        pr: { anyOf: [{ type: "number" }, { type: "string" }, { type: "array", items: { type: "string" } }], description: "Pull request number, URL, branch, or array for batch checkout." },
        force: { type: "boolean", description: "Reset an existing local PR branch during pr_checkout." },
        title: stringProperty("Pull request title for pr_create."),
        body: stringProperty("Pull request description/body."),
        fill: { type: "boolean", description: "Auto-fill PR title/body from local commits when possible." },
        draft: { type: "boolean", description: "Request draft PR creation where Bitbucket supports it." },
        base: stringProperty("OMP-compatible alias for targetBranch."),
        head: stringProperty("OMP-compatible alias for sourceBranch."),
        sourceBranch: stringProperty("Source branch for pr_create."),
        targetBranch: stringProperty("Target branch for pr_create. Defaults to main."),
        branch: stringProperty("Local branch for pr_checkout/pr_push, or source branch fallback for pr_create."),
        query: stringProperty("Search query. For Server PR search this is applied client-side to the returned page."),
        since: stringProperty("Lower-bound date filter. Supports relative durations like 3d and ISO dates where Alpha can filter returned data."),
        until: stringProperty("Upper-bound date filter. Supports relative durations like 3d and ISO dates where Alpha can filter returned data."),
        dateField: { type: "string", enum: ["created", "updated"], description: "Date field for since/until filters. Defaults to created." },
        limit: { type: "number", description: "Maximum result count, clamped to 1-100." },
        state: stringProperty("Pull request state such as OPEN, MERGED, DECLINED, or ALL."),
        comment: stringProperty("Comment text for pr_comment."),
        message: stringProperty("Alias for comment text."),
        reviewer: { type: "array", items: { type: "string" }, description: "Reviewers for pr_create. Server expects usernames; Cloud expects UUIDs." },
        assignee: { type: "array", items: { type: "string" }, description: "OMP compatibility field. Bitbucket PR assignment is host/version-specific." },
        label: { type: "array", items: { type: "string" }, description: "OMP compatibility field. Bitbucket PR labels are host/version-specific." },
        closeSourceBranch: { type: "boolean", description: "Close source branch after merge where Bitbucket supports it." },
        forceWithLease: { type: "boolean", description: "Use --force-with-lease for pr_push." },
        run: stringProperty("Pipeline/build run id for run_watch. Present for OMP schema parity; host-limited in Alpha."),
        tail: { type: "number", description: "Failed build log tail lines for run_watch. Present for OMP schema parity." },
      },
      ["op"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/bitbucket.js")).bitbucketTool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "job",
    visibility: "public",
    loadMode: "discoverable",
    description: "Inspect, wait for, or cancel async bash/task jobs. Use list for a snapshot, poll to wait for jobs, and cancel to stop running jobs.",
    inputSchema: objectSchema(
      {
        list: { type: "boolean", description: "Snapshot all visible background jobs." },
        poll: { type: "array", items: { type: "string" }, description: "Job ids to wait for; omit with no list/cancel to wait on all running jobs." },
        cancel: { type: "array", items: { type: "string" }, description: "Job ids to cancel." },
      },
      [],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/job.js")).jobTool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "task",
    visibility: "public",
    loadMode: "discoverable",
    description: "Spawn Alpha subagents using OMP-style batch task shape. Subagents run with isolated prompt context and Alpha tools; VS Code host limits isolated worktrees, IRC keep-alive, and OMP TUI lifecycle channels.",
    inputSchema: objectSchema(
      {
        agent: stringProperty("Agent type to spawn, such as task, quick_task, explore, reviewer, plan, or a custom .omp/agents agent."),
        context: stringProperty("Shared background prepended to every assignment: goal, constraints, shared contract, and required facts."),
        tasks: {
          type: "array",
          minItems: 1,
          description: "Tasks to spawn; one subagent per item.",
          items: {
            type: "object",
            properties: {
              id: stringProperty("Stable agent id, CamelCase, <=32 chars; generated when omitted."),
              description: stringProperty("UI label only; subagent does not see it."),
              assignment: stringProperty("Complete, self-contained instructions. Include exact files, non-goals, and acceptance criteria."),
              isolated: { type: "boolean", description: "OMP compatibility field. Alpha reports this unsupported in the VS Code host." },
            },
            required: ["assignment"],
            additionalProperties: false,
          },
        },
      },
      ["agent", "context", "tasks"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/task.js")).taskTool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "eval",
    visibility: "public",
    loadMode: "discoverable",
    description: "Execute OMP-style JavaScript or Python cells. JS runs in a persistent Alpha VM; Python uses a subprocess backend. Use for deterministic local computation and scripted tool workflows.",
    inputSchema: objectSchema(
      {
        cells: {
          type: "array",
          minItems: 1,
          description: "Cells executed in order. State persists for JS where Node VM supports it.",
          items: {
            type: "object",
            properties: {
              language: { type: "string", enum: ["py", "js"], description: "Runtime language." },
              code: stringProperty("Cell body, verbatim. No markdown fences needed."),
              title: stringProperty("Short transcript label."),
              timeout: { type: "number", description: "Per-cell timeout in seconds, 1-3600. Default 30." },
              reset: { type: "boolean", description: "Reset this cell's language runtime before running." },
            },
            required: ["language", "code"],
            additionalProperties: false,
          },
        },
      },
      ["cells"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/eval.js")).evalTool,
    toArgs: (input) => JSON.stringify(input),
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
    loadTool: async () => (await import("./tools/resolve.js")).resolveTool,
    toArgs: (input) => JSON.stringify(input),
  },
  {
    name: "todo",
    visibility: "public",
    loadMode: "discoverable",
    description: "Manage an OMP-style phased todo list. Tasks are referenced by verbatim content, not IDs.",
    inputSchema: objectSchema(
      {
        ops: {
          type: "array",
          minItems: 1,
          description: "Ordered todo operations.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["init", "start", "done", "rm", "drop", "append", "view"],
                description: "Todo operation.",
              },
              list: {
                type: "array",
                description: "Phased task list for init.",
                items: {
                  type: "object",
                  properties: {
                    phase: stringProperty("Phase name."),
                    items: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string" },
                      description: "Task contents for this phase.",
                    },
                  },
                  required: ["phase", "items"],
                  additionalProperties: false,
                },
              },
              task: stringProperty("Exact task content to start, complete, drop, or remove."),
              phase: stringProperty("Exact phase name to complete, drop, remove, or append to."),
              items: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                description: "Task contents to append.",
              },
            },
            required: ["op"],
            additionalProperties: false,
          },
        },
      },
      ["ops"],
    ),
    enabled: alwaysEnabled,
    loadTool: async () => (await import("./tools/todo.js")).todoTool,
    toArgs: (input) => JSON.stringify(input),
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

export function getDiscoverableAlphaToolMetadata(activeToolNames: ReadonlySet<string> = new Set()): DiscoverableTool[] {
  return alphaToolRegistry
    .filter((tool) => tool.visibility === "public" && tool.loadMode === "discoverable" && tool.enabled() && !activeToolNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      label: tool.name,
      summary: tool.description,
      source: "builtin",
      schemaKeys: schemaKeys(tool.inputSchema),
    }));
}

export function isDiscoverableAlphaToolName(name: string): boolean {
  return alphaToolRegistry.some((tool) => tool.name === name && tool.visibility === "public" && tool.loadMode === "discoverable");
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
