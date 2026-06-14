import * as vscode from "vscode";
import { ensureToolPermission } from "./approval";
import {
  buildGitOverview,
  changedFiles,
  ensureStagedChanges,
  executeCommitPlan,
  fileDiff,
  formatCommitPlan,
  git,
  parseCommitCommandArgs,
  parseDiffChunks,
  recentCommits,
  validateCommitProposal,
  validateSplitCommitPlan,
  type CommitAgentState,
  type CommitPlan,
} from "./commitCore";
import { wrapInternalForModel } from "./transcript";
import type { AlphaContext, ToolResult } from "./types";
import { workspaceRoot } from "./workspace";

const MAX_COMMIT_TOOL_ROUNDS = 8;

const COMMIT_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: "git_overview",
    description: "Return staged files, diff stat summary, numstat entries, scope candidates, and lock files excluded from analysis. Always call first.",
    inputSchema: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "Use staged changes. Default true." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_file_diff",
    description: "Return the diff for specific files. Prefer 1-2 calls for key files.",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
        staged: { type: "boolean", description: "Use staged changes. Default true." },
      },
      required: ["files"],
      additionalProperties: false,
    },
  },
  {
    name: "git_hunk",
    description: "Return specific hunks from a file diff. Use only for large diffs.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        hunks: { type: "array", items: { type: "number" } },
        staged: { type: "boolean", description: "Use staged changes. Default true." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "recent_commits",
    description: "Return recent commit subjects for style context.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of commits. Default 12." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "propose_commit",
    description: "Submit the final single conventional commit proposal.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["feat", "fix", "refactor", "perf", "docs", "test", "build", "ci", "chore", "style", "revert"] },
        scope: { anyOf: [{ type: "string" }, { type: "null" }] },
        summary: { type: "string" },
        details: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              userVisible: { type: "boolean" },
            },
            required: ["text"],
            additionalProperties: false,
          },
        },
        issue_refs: { type: "array", items: { type: "string" } },
      },
      required: ["type", "scope", "summary", "details", "issue_refs"],
      additionalProperties: false,
    },
  },
  {
    name: "split_commit",
    description: "Submit multiple atomic commits for unrelated staged changes. Cover all non-lock staged files exactly once; dependencies are zero-based commit indices.",
    inputSchema: {
      type: "object",
      properties: {
        commits: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: {
              changes: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    hunks: {
                      anyOf: [
                        { type: "object", properties: { type: { type: "string", enum: ["all"] } }, required: ["type"], additionalProperties: false },
                        {
                          type: "object",
                          properties: {
                            type: { type: "string", enum: ["indices"] },
                            indices: { type: "array", minItems: 1, items: { type: "number" } },
                          },
                          required: ["type", "indices"],
                          additionalProperties: false,
                        },
                        {
                          type: "object",
                          properties: {
                            type: { type: "string", enum: ["lines"] },
                            start: { type: "number" },
                            end: { type: "number" },
                          },
                          required: ["type", "start", "end"],
                          additionalProperties: false,
                        },
                      ],
                    },
                  },
                  required: ["path", "hunks"],
                  additionalProperties: false,
                },
              },
              type: { type: "string", enum: ["feat", "fix", "refactor", "perf", "docs", "test", "build", "ci", "chore", "style", "revert"] },
              scope: { anyOf: [{ type: "string" }, { type: "null" }] },
              summary: { type: "string" },
              details: { type: "array", items: { type: "object", properties: { text: { type: "string" }, userVisible: { type: "boolean" } }, required: ["text"], additionalProperties: false } },
              issue_refs: { type: "array", items: { type: "string" } },
              rationale: { type: "string" },
              dependencies: { type: "array", items: { type: "number" } },
            },
            required: ["changes", "type", "scope", "summary"],
            additionalProperties: false,
          },
        },
      },
      required: ["commits"],
      additionalProperties: false,
    },
  },
];

export async function runAlphaCommit(rawArgs: string, ctx: AlphaContext): Promise<void> {
  const args = parseCommitCommandArgs(rawArgs);
  const cwd = workspaceRoot().fsPath;
  const staged = await ensureStagedChanges(cwd);
  if (staged.stagedFiles.length === 0) {
    ctx.stream.markdown("No changes to commit.");
    return;
  }

  await ensureToolPermission(
    {
      name: "commit",
      approval: "exec",
      formatApprovalDetails: () => [
        args.dryRun ? "Mode: dry run" : "Mode: create commit(s)",
        staged.autoStaged ? "Staged: all workspace changes automatically" : "Staged: existing staged changes",
        args.ticket ? `Ticket: ${args.ticket}` : "Ticket: none",
        `Files: ${staged.stagedFiles.slice(0, 12).join(", ")}${staged.stagedFiles.length > 12 ? ` (+${staged.stagedFiles.length - 12} more)` : ""}`,
      ],
    },
    { dryRun: args.dryRun, push: args.push },
    ctx,
  );

  const state: CommitAgentState = {
    diffText: await git(cwd, ["diff", "--cached"]),
  };
  const plan = await runCommitModelLoop(cwd, args.context, args.ticket, ctx, state);
  if (!plan) {
    ctx.stream.markdown("Commit agent did not provide a valid proposal.");
    return;
  }

  if (args.dryRun) {
    ctx.stream.markdown(formatCommitPlan(plan, { ticket: args.ticket }));
    return;
  }

  const result = await executeCommitPlan(cwd, plan, { push: args.push, ticket: args.ticket });
  ctx.stream.markdown(result);
}

async function runCommitModelLoop(cwd: string, userContext: string | undefined, ticket: string | undefined, ctx: AlphaContext, state: CommitAgentState): Promise<CommitPlan | undefined> {
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(wrapInternalForModel(buildCommitSystemPrompt(), "alpha-system"), "alpha_internal"),
    vscode.LanguageModelChatMessage.User(buildCommitUserPrompt(userContext, ticket), "alpha_internal"),
  ];

  for (let round = 0; round < MAX_COMMIT_TOOL_ROUNDS; round++) {
    const response = await ctx.request.model.sendRequest(
      messages,
      { tools: COMMIT_TOOLS, toolMode: vscode.LanguageModelChatToolMode.Auto },
      ctx.token,
    );

    const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart || chunk instanceof vscode.LanguageModelToolCallPart) {
        assistantParts.push(chunk);
        if (chunk instanceof vscode.LanguageModelToolCallPart) toolCalls.push(chunk);
      }
    }

    if (assistantParts.length) messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    if (!toolCalls.length) {
      messages.push(vscode.LanguageModelChatMessage.User("You must finish by calling propose_commit or split_commit with a valid proposal.", "alpha_internal"));
      continue;
    }

    for (const call of toolCalls) {
      const result = await runCommitTool(cwd, call.name, call.input, state);
      messages.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result.markdown)]),
        ]),
      );
    }

    if (state.proposal) return { kind: "single", proposal: state.proposal };
    if (state.splitProposal) return { kind: "split", plan: state.splitProposal };
  }
  return undefined;
}

async function runCommitTool(cwd: string, name: string, input: unknown, state: CommitAgentState): Promise<ToolResult> {
  try {
    if (name === "git_overview") {
      const overview = await buildGitOverview(cwd, booleanField(input, "staged", true));
      state.overview = overview;
      return { markdown: JSON.stringify(overview, null, 2) };
    }
    if (name === "git_file_diff") {
      const files = arrayStringField(input, "files").slice(0, 10);
      return { markdown: await fileDiff(cwd, files, booleanField(input, "staged", true)) };
    }
    if (name === "git_hunk") {
      const file = stringField(input, "file");
      const diff = await fileDiff(cwd, [file], booleanField(input, "staged", true));
      const chunks = parseDiffChunks(diff.replace(/^=== .+ ===\n/, ""));
      const chunk = chunks.find((item) => item.path === file);
      const requested = arrayNumberField(input, "hunks");
      const hunks = chunk?.hunks.filter((hunk) => !requested.length || requested.includes(hunk.index + 1)) ?? [];
      return { markdown: hunks.length ? hunks.map((hunk) => hunk.content).join("\n\n") : "(no matching hunks)" };
    }
    if (name === "recent_commits") {
      return { markdown: await recentCommits(cwd, numberField(input, "count", 12)) };
    }
    if (name === "propose_commit") {
      const files = state.overview?.files ?? await changedFiles(cwd, true);
      const validation = validateCommitProposal(input, files, state.diffText);
      if (validation.valid && validation.proposal) state.proposal = validation.proposal;
      return { markdown: JSON.stringify({ ...validation, constraints: { maxSummaryChars: 72, maxDetailItems: 6 } }, null, 2) };
    }
    if (name === "split_commit") {
      const files = state.overview?.files ?? await changedFiles(cwd, true);
      const diffText = state.diffText ?? await git(cwd, ["diff", "--cached"]);
      const validation = validateSplitCommitPlan(input, files, diffText);
      if (validation.valid && validation.proposal) state.splitProposal = validation.proposal;
      return { markdown: JSON.stringify({ ...validation, constraints: { maxSummaryChars: 72, maxDetailItems: 6 } }, null, 2) };
    }
    return { markdown: `Unknown commit tool: ${name}` };
  } catch (error) {
    return { markdown: `Commit tool ${name} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function buildCommitSystemPrompt(): string {
  return [
    "You are Alpha commit workflow's conventional commit expert.",
    "",
    "Your job: decide needed git info, gather via tools, then call exactly one:",
    "- propose_commit (single commit)",
    "- split_commit (multiple commits when changes are unrelated)",
    "",
    "Workflow rules:",
    "1. Always call git_overview first.",
    "2. Keep tool calls minimal: prefer 1-2 git_file_diff calls for key files.",
    "3. Use git_hunk only for large diffs.",
    "4. Use recent_commits only if you need style context.",
    "5. Do not use read, bash, edit, write, or general Alpha tools.",
    "",
    "Commit requirements:",
    "- Summary line: past-tense verb, <= 72 chars, no trailing period.",
    "- Avoid filler words: comprehensive, various, several, improved, enhanced, better.",
    "- Avoid meta phrases: this commit, this change, updated code, modified files.",
    "- Scope: lowercase, max two segments; only letters, digits, hyphens, underscores.",
    "- Detail lines optional, 0-6. Each sentence ending in period, <= 120 chars.",
    "",
    "Conventional commit types: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert.",
    "",
    "Split rules:",
    "- Use split_commit when staged changes are unrelated.",
    "- Each non-lock staged file must be covered exactly once.",
    "- Use dependencies as zero-based commit indices when one commit must come after another.",
    "- Source files should drive the headline commit over tests, docs, and config.",
    "- Lock files are excluded from analysis.",
  ].join("\n");
}

function buildCommitUserPrompt(userContext: string | undefined, ticket: string | undefined): string {
  return [
    "Generate a conventional commit proposal for current staged changes.",
    "",
    ticket ? `Jira ticket: ${ticket}. Alpha will prefix the final commit header with \`${ticket}: \`; do not include the ticket in proposal summaries.` : undefined,
    userContext ? `User context:\n${userContext}\n` : undefined,
    "Use git_* tools to inspect changes. Finish with propose_commit or split_commit.",
  ].filter((part): part is string => typeof part === "string").join("\n");
}

function objectRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function booleanField(input: unknown, key: string, fallback: boolean): boolean {
  const value = objectRecord(input)[key];
  return typeof value === "boolean" ? value : fallback;
}

function stringField(input: unknown, key: string): string {
  const value = objectRecord(input)[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function numberField(input: unknown, key: string, fallback: number): number {
  const value = objectRecord(input)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function arrayStringField(input: unknown, key: string): string[] {
  const value = objectRecord(input)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function arrayNumberField(input: unknown, key: string): number[] {
  const value = objectRecord(input)[key];
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter(Number.isFinite);
}
