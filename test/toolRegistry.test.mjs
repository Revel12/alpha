import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_ESSENTIAL_TOOL_NAMES,
  alphaToolRegistry,
  getAdvertisedAlphaLanguageModelTools,
  getAdvertisedAlphaTools,
  getDiscoverableAlphaToolNames,
  getEssentialAlphaToolNames,
  getAlphaToolRegistration,
} from "../out/toolRegistry.js";
import { buildAlphaSystemPrompt } from "../out/promptBuilder.js";
import {
  completeGoal,
  createGoal,
  createGoalState,
  dropGoal,
  goalModeSystemPrompt,
  goalToolResponse,
  isGoalContinuationActive,
  parseGoalCommand,
  remainingTokens,
  renderGoalContinuationHint,
  renderGoalToolResponse,
  resumeGoal,
  updateGoalBudget,
} from "../out/goalMode.js";
import {
  askApproval,
  bashApproval,
  bitbucketApproval,
  browserApproval,
  editApproval,
  evalApproval,
  lspApproval,
  resolveApproval,
  sshApproval,
  taskApproval,
  webSearchApproval,
  writeApproval,
} from "../out/approvalCore.js";
import {
  ASK_OTHER_OPTION,
  ASK_RECOMMENDED_SUFFIX,
  formatAskResult,
  optionLabelForDisplay,
  parseAskInput,
  stripRecommendedSuffix,
} from "../out/askCore.js";
import {
  notebookToText,
  readArchiveTarget,
  readImageMetadata,
  readWebUrl,
  splitArchiveTarget,
  splitSqliteTarget,
  structuralSummary,
} from "../out/readAdapters.js";
import {
  duckDuckGoHtmlUrl,
  formatWebSearchForLlm,
  parseDuckDuckGoHtml,
  parseWebSearchInput,
} from "../out/webSearchCore.js";
import { InMemoryArtifactStore, InMemoryConflictStore, InMemoryFileSnapshotStore, InMemoryPendingEditStore, InMemoryPermissionDecisionStore, InMemoryTodoStore } from "../out/store.js";
import { InMemoryBashJobStore, InMemoryDiscoveredToolStore } from "../out/store.js";
import {
  expandConflictTokens,
  parseConflictUri,
  renderConflictRegion,
  scanConflictLines,
  spliceConflict,
} from "../out/conflictCore.js";
import { jobTool } from "../out/tools/job.js";
import { goalTool } from "../out/tools/goal.js";
import {
  parseEvalInput,
  runEvalCells,
  validateEvalParams,
} from "../out/evalCore.js";
import {
  agentForPlanMode,
  agentToolNames,
  allocateNestedTaskId,
  canSpawnAtDepth,
  discoverAgents,
  isAgentSpawnAllowed,
  normalizeSpawnAllowance,
  parseAgent,
  renderSubagentPrompt,
  renderTaskDescription,
  renderTaskSummary,
  resolveSpawnItems,
  spawnParamsFor,
  validateAgentOutput,
  validateSpawnPermission,
  validateShapeParams,
  validateSpawnParams,
} from "../out/taskCore.js";
import {
  markdownToPhases,
  phasesToMarkdown,
  selectStickyTodoWindow,
  todoMatchesAnyDescription,
  todoTool,
} from "../out/tools/todo.js";
import { searchToolBm25Tool } from "../out/tools/searchToolBm25.js";
import {
  normalizeArchiveSubPath,
  parseArchiveWriteTarget,
  parseSqliteWriteTarget,
  writeArchiveEntry,
} from "../out/writeAdapters.js";
import {
  includeGlobsForSearch,
  parseSearchInput,
  renderSearchResults,
  searchText,
  truncateSearchOutput,
} from "../out/searchCore.js";
import {
  findExcludeGlob,
  findIncludeGlobs,
  matchesFindGlob,
  mergeFindEntries,
  parseFindInput,
  renderFindResults,
  truncateFindOutput,
} from "../out/findCore.js";
import {
  buildDiscoverableToolSearchIndex,
  searchDiscoverableTools,
} from "../out/toolDiscoveryCore.js";
import {
  buildAlphaTranscript,
  buildModelTranscript,
  firstUserPromptFromTranscript,
  renderTranscriptMarkdown,
  wrapInternalForModel,
} from "../out/transcript.js";
import {
  buildReviewPrompt,
  getRecommendedAgentCount,
  parseDiff,
  parseReportFindingDetails,
  toReviewFinding,
} from "../out/reviewCore.js";
import {
  buildPatchForChange,
  computeDependencyOrder,
  formatCommitMessage,
  parseCommitCommandArgs,
  parseDiffChunks,
  validateCommitProposal,
  validateSplitCommitPlan,
} from "../out/commitCore.js";
import {
  formatCodeActions,
  formatDiagnostics,
  formatIacLspStatus,
  formatLocations,
  formatLspStatus,
  formatWorkspaceEditPreview,
  OMP_IAC_LSP_PROFILES,
  parseLspInput,
  selectCodeActionIndex,
  unsupportedLspAction,
} from "../out/lspCore.js";
import {
  duplicateTopLevelPythonDefinitions,
} from "../out/pythonStaticChecks.js";
import {
  buildPlanGoalObjective,
  assertPlanModeWriteAllowed,
  createPlanModeState,
  isPlanApprovalAsGoalPrompt,
  planModeSystemPrompt,
  renderPlanReview,
} from "../out/planMode.js";
import {
  applyJsonPath,
  parseJsonPath,
} from "../out/jsonPath.js";
import {
  BITBUCKET_OPS,
  bitbucketApiUrl,
  bitbucketCodeSearchUrls,
  applyBitbucketDateFilter,
  buildCheckoutMetadata,
  bitbucketPrPayload,
  parseSearchDateBound,
  formatBitbucketCodeSearchResults,
  formatBitbucketPr,
  normalizeBitbucketCodeSearchResults,
  parseBitbucketInput,
  parseBitbucketRemoteUrl,
  requireBitbucketCodeSearchQuery,
  resolveBitbucketAuth,
  resolveBitbucketRepo,
  unsupportedBitbucketOp,
} from "../out/bitbucketCore.js";
test("public tools are advertised by default", () => {
  const names = getAdvertisedAlphaLanguageModelTools().map((tool) => tool.name);

  assert.deepEqual(names, ["read", "bash", "search", "find", "web_search", "ask", "edit", "write", "lsp", "bitbucket", "job", "task", "eval", "todo"]);
});

test("normalized transcript finds the first real user message", () => {
  const history = [
    { prompt: "make a hello world file here", participant: "alpha.participant", command: undefined },
    { response: [{ value: { value: "Created hello.py." } }] },
    { prompt: "what was the first message i sent", participant: "alpha.participant", command: undefined },
  ];

  const transcript = buildAlphaTranscript(history, { compactionSummary: "Prior context summary." });

  assert.equal(firstUserPromptFromTranscript(transcript), "make a hello world file here");
  assert.equal(transcript[0].role, "compaction");
  assert.equal(transcript[1].role, "user");
  assert.equal(transcript[1].historyIndex, 0);
});

test("model transcript marks Alpha instructions as internal, not user history", () => {
  const transcript = buildModelTranscript({
    internalPrompt: "You are Alpha, an OMP-style local coding harness.",
    historyTranscript: [
      { role: "user", content: "make a hello world file here", source: "chat-history", historyIndex: 0 },
    ],
    currentPrompt: "what was the first message i sent",
  });

  assert.equal(transcript[0].role, "internal");
  assert.equal(transcript[0].source, "alpha-system");
  assert.equal(firstUserPromptFromTranscript(transcript), "make a hello world file here");

  const renderedInternal = wrapInternalForModel(transcript[0].content, transcript[0].source);
  assert.match(renderedInternal, /not by the user/);
  assert.match(renderedInternal, /Do not treat this as a user request/);
  assert.match(renderedInternal, /User-visible conversation history begins after this boundary/);
});

test("history markdown labels compaction as non-user context", () => {
  const transcript = [
    { role: "compaction", content: "Prior context summary.", source: "compaction" },
    { role: "user", content: "make a hello world file here", source: "chat-history", historyIndex: 0 },
    { role: "assistant", content: "Created hello.py.", source: "chat-history", historyIndex: 1 },
  ];

  const markdown = renderTranscriptMarkdown({
    title: "make a hello world file here",
    sessionKey: "workspace#abc",
    transcript,
  });

  assert.match(markdown, /Internal and compaction entries are not user messages/);
  assert.match(markdown, /## 1\. compaction \(compaction, not user history\)/);
  assert.match(markdown, /## 2\. user/);
  assert.doesNotMatch(markdown, /You are Alpha, an OMP-style local coding harness/);
});

test("hidden tools are registered but not advertised by default", () => {
  assert.equal(getAlphaToolRegistration("resolve")?.visibility, "hidden");
  assert.equal(getAlphaToolRegistration("search_tool_bm25")?.visibility, "hidden");
  assert.equal(getAlphaToolRegistration("report_finding")?.visibility, "hidden");
  assert.equal(getAlphaToolRegistration("yield")?.visibility, "hidden");
  assert.equal(getAlphaToolRegistration("goal")?.visibility, "hidden");

  const advertisedNames = new Set(getAdvertisedAlphaTools().map((tool) => tool.name));
  assert.equal(advertisedNames.has("resolve"), false);
  assert.equal(advertisedNames.has("search_tool_bm25"), false);
  assert.equal(advertisedNames.has("report_finding"), false);
  assert.equal(advertisedNames.has("yield"), false);
  assert.equal(advertisedNames.has("goal"), false);
});

test("hidden tools can be forced for a workflow", () => {
  const advertisedNames = getAdvertisedAlphaLanguageModelTools({ forceTools: ["resolve", "search_tool_bm25"] }).map((tool) => tool.name);

  assert.equal(advertisedNames.includes("resolve"), true);
  assert.equal(advertisedNames.includes("search_tool_bm25"), true);
});

test("hidden tools can be selected as the only forced workflow tool", () => {
  const advertisedNames = getAdvertisedAlphaLanguageModelTools({ forceTools: ["resolve"], onlyForced: true }).map((tool) => tool.name);

  assert.deepEqual(advertisedNames, ["resolve"]);
});

test("search_tool_bm25 exposes OMP-style discovery schema", () => {
  const tool = getAlphaToolRegistration("search_tool_bm25");

  assert.equal(tool.loadMode, "essential");
  assert.deepEqual(tool.inputSchema.required, ["query"]);
  assert.equal(tool.inputSchema.properties.query.type, "string");
  assert.equal(tool.inputSchema.properties.limit.type, "number");
});

test("review workflow exposes hidden report_finding and yield schemas", () => {
  const report = getAlphaToolRegistration("report_finding");
  const yieldTool = getAlphaToolRegistration("yield");

  assert.equal(report.visibility, "hidden");
  assert.deepEqual(report.inputSchema.required, ["title", "body", "priority", "confidence", "file_path", "line_start", "line_end"]);
  assert.deepEqual(report.inputSchema.properties.priority.enum, ["P0", "P1", "P2", "P3"]);
  assert.equal(yieldTool.visibility, "hidden");
  assert.equal(yieldTool.inputSchema.properties.data.type, "object");
});

test("goal exposes OMP-style mode-gated schema", () => {
  const goal = getAlphaToolRegistration("goal");

  assert.equal(goal.visibility, "hidden");
  assert.deepEqual(goal.inputSchema.required, ["op"]);
  assert.deepEqual(goal.inputSchema.properties.op.enum, ["create", "get", "complete", "resume", "drop"]);
  assert.equal(goal.inputSchema.properties.objective.type, "string");
  assert.equal(goal.inputSchema.properties.token_budget.type, "number");

  const activeCtx = makeToolContext({ goalMode: createGoalState("Ship the thing") });
  const names = getAdvertisedAlphaLanguageModelTools({ ctx: activeCtx, forceTools: ["goal"] }).map((tool) => tool.name);
  assert.equal(names.includes("goal"), true);
});

test("essential-only selection follows OMP-style load modes", () => {
  assert.deepEqual(DEFAULT_ESSENTIAL_TOOL_NAMES, ["read", "bash", "edit"]);
  assert.deepEqual(getEssentialAlphaToolNames(), ["read", "bash", "edit"]);

  const advertisedNames = getAdvertisedAlphaLanguageModelTools({ includeDiscoverable: false }).map((tool) => tool.name);
  assert.deepEqual(advertisedNames, ["read", "bash", "edit"]);
});

test("discoverable public tools are classified separately from essentials", () => {
  assert.deepEqual(getDiscoverableAlphaToolNames(), ["search", "find", "web_search", "ask", "write", "lsp", "bitbucket", "job", "task", "eval", "todo"]);
});

test("registry names are unique", () => {
  const names = alphaToolRegistry.map((tool) => tool.name);

  assert.equal(new Set(names).size, names.length);
});

test("registered tools carry lazy handlers", () => {
  for (const tool of alphaToolRegistry) {
    assert.equal(typeof tool.loadTool, "function");
  }
});

test("edit uses the OMP-style input field", () => {
  const edit = getAlphaToolRegistration("edit");

  assert.deepEqual(edit.inputSchema.required, ["input"]);
  assert.equal(edit.inputSchema.properties.input.type, "string");
});

test("bash uses the OMP-style command contract", () => {
  const bash = getAlphaToolRegistration("bash");

  assert.equal(bash.loadMode, "essential");
  assert.deepEqual(bash.inputSchema.required, ["command"]);
  assert.equal(bash.inputSchema.properties.command.type, "string");
  assert.equal(bash.inputSchema.properties.cwd.type, "string");
  assert.equal(bash.inputSchema.properties.timeout.type, "number");
  assert.equal(bash.inputSchema.properties.async.type, "boolean");
  assert.equal(bash.inputSchema.properties.pty.type, "boolean");
});

test("search exposes OMP-style scoped search options", () => {
  const search = getAlphaToolRegistration("search");

  assert.deepEqual(search.inputSchema.required, ["pattern"]);
  assert.equal(search.inputSchema.properties.pattern.type, "string");
  assert.equal(search.inputSchema.properties.paths.anyOf.length, 2);
  assert.equal(search.inputSchema.properties.i.type, "boolean");
  assert.equal(search.inputSchema.properties.gitignore.type, "boolean");
  assert.equal(search.inputSchema.properties.skip.type, "number");
  assert.equal(search.inputSchema.properties.contextBefore.type, "number");
  assert.equal(search.inputSchema.properties.contextAfter.type, "number");
  assert.equal(search.inputSchema.properties.maxResults.type, "number");
});

test("find exposes OMP-style paths contract", () => {
  const find = getAlphaToolRegistration("find");

  assert.deepEqual(find.inputSchema.required, ["paths"]);
  assert.equal(find.inputSchema.properties.paths.type, "array");
  assert.equal(find.inputSchema.properties.hidden.type, "boolean");
  assert.equal(find.inputSchema.properties.gitignore.type, "boolean");
  assert.equal(find.inputSchema.properties.limit.type, "number");
  assert.equal(find.inputSchema.properties.timeout.type, "number");
});

test("web_search exposes OMP-style query contract", () => {
  const tool = getAlphaToolRegistration("web_search");

  assert.deepEqual(tool.inputSchema.required, ["query"]);
  assert.equal(tool.inputSchema.properties.query.type, "string");
  assert.deepEqual(tool.inputSchema.properties.recency.enum, ["day", "week", "month", "year"]);
  assert.equal(tool.inputSchema.properties.limit.type, "number");
  assert.equal(tool.inputSchema.properties.num_search_results.type, "number");
});

test("ask exposes OMP-style question picker contract", () => {
  const tool = getAlphaToolRegistration("ask");

  assert.equal(tool.visibility, "public");
  assert.equal(tool.loadMode, "discoverable");
  assert.deepEqual(tool.inputSchema.required, ["questions"]);
  const question = tool.inputSchema.properties.questions.items;
  assert.deepEqual(question.required, ["id", "question", "options"]);
  assert.equal(question.properties.multi.type, "boolean");
  assert.equal(question.properties.recommended.type, "number");
});

test("lsp exposes OMP-style action contract", () => {
  const lsp = getAlphaToolRegistration("lsp");

  assert.equal(lsp.visibility, "public");
  assert.equal(lsp.loadMode, "discoverable");
  assert.deepEqual(lsp.inputSchema.required, ["action"]);
  assert.deepEqual(lsp.inputSchema.properties.action.enum, [
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
  ]);
  assert.equal(lsp.inputSchema.properties.file.type, "string");
  assert.equal(lsp.inputSchema.properties.line.type, "number");
  assert.equal(lsp.inputSchema.properties.symbol.type, "string");
  assert.equal(lsp.inputSchema.properties.new_name.type, "string");
});

test("bitbucket exposes OMP-style repo-host workflow contract", () => {
  const bitbucket = getAlphaToolRegistration("bitbucket");

  assert.equal(bitbucket.visibility, "public");
  assert.equal(bitbucket.loadMode, "discoverable");
  assert.deepEqual(bitbucket.inputSchema.required, ["op"]);
  assert.deepEqual(bitbucket.inputSchema.properties.op.enum, BITBUCKET_OPS);
  assert.equal(bitbucket.inputSchema.properties.repo.type, "string");
  assert.equal(bitbucket.inputSchema.properties.baseUrl.type, "string");
  assert.equal(bitbucket.inputSchema.properties.pr.anyOf.length, 3);
  assert.equal(bitbucket.inputSchema.properties.force.type, "boolean");
  assert.equal(bitbucket.inputSchema.properties.title.type, "string");
  assert.equal(bitbucket.inputSchema.properties.fill.type, "boolean");
  assert.equal(bitbucket.inputSchema.properties.draft.type, "boolean");
  assert.equal(bitbucket.inputSchema.properties.base.type, "string");
  assert.equal(bitbucket.inputSchema.properties.head.type, "string");
  assert.equal(bitbucket.inputSchema.properties.sourceBranch.type, "string");
  assert.equal(bitbucket.inputSchema.properties.targetBranch.type, "string");
  assert.deepEqual(bitbucket.inputSchema.properties.dateField.enum, ["created", "updated"]);
  assert.equal(bitbucket.inputSchema.properties.comment.type, "string");
  assert.equal(bitbucket.inputSchema.properties.assignee.type, "array");
  assert.equal(bitbucket.inputSchema.properties.label.type, "array");
  assert.equal(bitbucket.inputSchema.properties.forceWithLease.type, "boolean");
});

test("todo exposes OMP-style phased ops contract", () => {
  const todo = getAlphaToolRegistration("todo");

  assert.equal(todo.visibility, "public");
  assert.equal(todo.loadMode, "discoverable");
  assert.deepEqual(todo.inputSchema.required, ["ops"]);
  assert.equal(todo.inputSchema.properties.ops.type, "array");
  assert.deepEqual(todo.inputSchema.properties.ops.items.properties.op.enum, [
    "init",
    "start",
    "done",
    "rm",
    "drop",
    "append",
    "view",
  ]);
  assert.equal(todo.inputSchema.properties.ops.items.properties.list.items.properties.phase.type, "string");
  assert.equal(todo.inputSchema.properties.ops.items.properties.items.type, "array");
});

test("todo init and done auto-promote the next pending task", async () => {
  const todos = new InMemoryTodoStore();
  const ctx = makeToolContext({ todos });

  const init = await todoTool.run(JSON.stringify({
    ops: [{
      op: "init",
      list: [
        { phase: "Foundation", items: ["Read current code", "Patch todo tool"] },
        { phase: "Verification", items: ["Run local tests"] },
      ],
    }],
  }), ctx);

  assert.match(init.markdown, /Remaining items \(3\):/);
  assert.deepEqual(todos.list()[0].tasks.map((task) => task.status), ["in_progress", "pending"]);

  const done = await todoTool.run(JSON.stringify({ ops: [{ op: "done", task: "Read current code" }] }), ctx);

  assert.match(done.markdown, /Patch todo tool \[in_progress\]/);
  assert.deepEqual(todos.list()[0].tasks.map((task) => task.status), ["completed", "in_progress"]);
});

test("todo start demotes any previous in-progress task", async () => {
  const todos = new InMemoryTodoStore();
  const ctx = makeToolContext({ todos });

  await todoTool.run(JSON.stringify({
    ops: [{ op: "init", list: [{ phase: "Implementation", items: ["First task", "Second task"] }] }],
  }), ctx);
  await todoTool.run(JSON.stringify({ ops: [{ op: "start", task: "Second task" }] }), ctx);

  assert.deepEqual(todos.list()[0].tasks.map((task) => task.status), ["pending", "in_progress"]);
});

test("todo append creates phases and failed duplicate batches do not mutate state", async () => {
  const todos = new InMemoryTodoStore();
  const ctx = makeToolContext({ todos });

  await todoTool.run(JSON.stringify({
    ops: [{ op: "append", phase: "Backlog", items: ["Handle retries", "Run tests"] }],
  }), ctx);

  assert.deepEqual(todos.list().map((phase) => phase.name), ["Backlog"]);
  assert.deepEqual(todos.list()[0].tasks.map((task) => task.status), ["in_progress", "pending"]);

  const before = todos.list();
  const duplicate = await todoTool.run(JSON.stringify({
    ops: [{ op: "append", phase: "Backlog", items: ["Handle retries", "Update docs"] }],
  }), ctx);

  assert.match(duplicate.markdown, /Errors: Task "Handle retries" already exists/);
  assert.deepEqual(todos.list(), before);
});

test("todo view is read-only and does not normalize old persisted state", async () => {
  const todos = new InMemoryTodoStore([{ name: "Legacy", tasks: [{ content: "Old pending task", status: "pending" }] }]);
  const ctx = makeToolContext({ todos });

  const viewed = await todoTool.run(JSON.stringify({ ops: [{ op: "view" }] }), ctx);

  assert.match(viewed.markdown, /Old pending task \[pending\]/);
  assert.equal(todos.list()[0].tasks[0].status, "pending");
});

test("todo markdown and sticky helpers match OMP behavior", () => {
  const phases = [
    {
      name: "Foundation",
      tasks: [
        { content: "Read current code", status: "completed" },
        { content: "Patch todo tool", status: "in_progress" },
        { content: "Dropped idea", status: "abandoned" },
      ],
    },
  ];

  const markdown = phasesToMarkdown(phases);
  assert.equal(markdown, "# Foundation\n- [x] Read current code\n- [/] Patch todo tool\n- [-] Dropped idea\n");

  const parsed = markdownToPhases("# Foundation\n- [x] Read current code\n- [ ] Patch todo tool\n").phases;
  assert.deepEqual(parsed[0].tasks.map((task) => task.status), ["completed", "in_progress"]);

  const sticky = selectStickyTodoWindow([
    { content: "one", status: "completed" },
    { content: "two", status: "pending" },
    { content: "three", status: "pending" },
  ], 1);
  assert.deepEqual(sticky.visible.map((task) => task.content), ["two"]);
  assert.equal(sticky.hiddenOpenCount, 1);

  assert.equal(todoMatchesAnyDescription("Patch todo tool", ["Sonnet #2: patch todo tool behavior"]), true);
});

test("lsp core parses and formats OMP-style outputs", () => {
  assert.deepEqual(parseLspInput(JSON.stringify({
    action: "references",
    file: "src/demo.ts",
    line: 10,
    symbol: "value#2",
    timeout: 120,
  })), {
    action: "references",
    file: "src/demo.ts",
    line: 10,
    symbol: "value#2",
    query: undefined,
    new_name: undefined,
    apply: undefined,
    timeout: 60,
    payload: undefined,
  });

  assert.match(formatLocations("reference", [{
    path: "src/demo.ts",
    line: 10,
    column: 5,
    context: "9:before\n10:value\n11:after",
  }]), /Found 1 reference\(s\):\n  src\/demo\.ts:10:5/);

  assert.match(formatDiagnostics([{
    path: "src/demo.ts",
    line: 1,
    column: 2,
    severity: "Error",
    message: "boom",
    source: "ts",
  }]), /1 error:\n- src\/demo\.ts:1:2 Error \[ts\]: boom/);

  assert.match(unsupportedLspAction("request", "host limitation"), /Unsupported lsp action 'request'/);
});

test("lsp core exposes OMP IaC parity profiles", () => {
  assert.deepEqual(OMP_IAC_LSP_PROFILES.map((profile) => profile.ompServer), [
    "yamlls",
    "terraformls",
    "dockerls",
    "helm-ls",
  ]);

  const status = formatIacLspStatus(["yaml", "terraform"], ["redhat.vscode-yaml", "hashicorp.terraform"]);
  assert.match(status, /YAML: OMP default yamlls/);
  assert.match(status, /Terraform: OMP default terraformls/);
  assert.match(status, /Dockerfile: OMP default dockerls/);
  assert.match(status, /Helm: OMP default helm-ls/);
  assert.match(status, /Suggested extension installed: yes \(redhat\.vscode-yaml\)/);
});

test("lsp core formats status with open-file diagnostics by language", () => {
  const status = formatLspStatus({
    openDocuments: [
      {
        path: "src/app.ts",
        languageId: "typescript",
        diagnostics: [{ path: "src/app.ts", line: 1, column: 1, severity: "Error", message: "bad" }],
      },
      {
        path: "deploy/main.tf",
        languageId: "terraform",
        diagnostics: [],
      },
    ],
    workspaceDiagnosticCount: 1,
    openLanguageIds: ["typescript", "terraform"],
    installedExtensionIds: ["hashicorp.terraform"],
  });

  assert.match(status, /Open document languages: terraform, typescript/);
  assert.match(status, /typescript: 1 diagnostic/);
  assert.match(status, /src\/app\.ts: 1 error/);
  assert.match(status, /deploy\/main\.tf: OK/);
  assert.match(status, /Terraform: OMP default terraformls/);
});

test("lsp core formats rename previews grouped by file", () => {
  const preview = formatWorkspaceEditPreview("Rename preview for nextValue", [
    { path: "src/a.ts", line: 2, column: 7, endLine: 2, endColumn: 12, oldText: "value", newText: "nextValue" },
    { path: "src/b.ts", line: 10, column: 14, endLine: 10, endColumn: 19, oldText: "value", newText: "nextValue" },
  ]);

  assert.match(preview, /Rename preview for nextValue: 2 edit\(s\) across 2 file\(s\)/);
  assert.match(preview, /# src\/a\.ts/);
  assert.match(preview, /old: "value"/);
  assert.match(preview, /new: "nextValue"/);
});

test("lsp core formats and selects code actions by index title and kind", () => {
  const actions = [
    { index: 0, title: "Organize Imports", kind: "source.organizeImports", editCount: 1 },
    { index: 1, title: "Add missing import", kind: "quickfix", diagnosticCount: 1, editCount: 1 },
    { index: 2, title: "Extract function", kind: "refactor.extract", disabledReason: "selection required" },
  ];
  const listing = formatCodeActions(actions);

  assert.match(listing, /0: Organize Imports \(kind=source\.organizeImports, edits=1\)/);
  assert.match(listing, /2: Extract function .*disabled=selection required/);
  assert.equal(selectCodeActionIndex(actions, "1"), 1);
  assert.equal(selectCodeActionIndex(actions, "missing import"), 1);
  assert.equal(selectCodeActionIndex(actions, "kind:source.organizeImports"), 0);
  assert.equal(selectCodeActionIndex(actions, "extract"), undefined);
});

test("post-mutation diagnostics catch duplicate top-level Python defs without LSP", () => {
  const checks = duplicateTopLevelPythonDefinitions("hello.py", [
    "def greet():",
    "    return 'hi'",
    "",
    "class Example:",
    "    def greet(self):",
    "        return 'method names are independent'",
    "",
    "def greet():",
    "    return 'again'",
  ].join("\n"));

  assert.equal(checks.length, 1);
  assert.match(checks[0], /hello\.py:8:1 Warning \[alpha-python\]: duplicate top-level function `greet`; first defined on line 1/);
});

test("bitbucket core parses input, auth, remotes, and API URLs", () => {
  assert.deepEqual(parseBitbucketInput(JSON.stringify({
    op: "pr_create",
    repo: "PROJ/service",
    title: "Add feature",
    head: "feature/demo",
    base: "main",
    force: true,
    fill: true,
    draft: true,
    pr: ["12", "13"],
    since: "3d",
    until: "2026-06-13",
    dateField: "updated",
    assignee: ["bob"],
    label: ["ready"],
    limit: 999,
  })), {
    op: "pr_create",
    repo: "PROJ/service",
    baseUrl: undefined,
    project: undefined,
    workspace: undefined,
    slug: undefined,
    pr: ["12", "13"],
    force: true,
    title: "Add feature",
    body: undefined,
    fill: true,
    draft: true,
    sourceBranch: "feature/demo",
    targetBranch: "main",
    branch: undefined,
    query: undefined,
    since: "3d",
    until: "2026-06-13",
    dateField: "updated",
    limit: 100,
    state: undefined,
    comment: undefined,
    reviewer: undefined,
    assignee: ["bob"],
    label: ["ready"],
    closeSourceBranch: undefined,
    forceWithLease: undefined,
    run: undefined,
    tail: 80,
  });

  assert.equal(resolveBitbucketAuth({ token: "abc" }), "Bearer abc");
  assert.equal(resolveBitbucketAuth({ username: "u", token: "p" }), `Basic ${Buffer.from("u:p").toString("base64")}`);

  assert.deepEqual(parseBitbucketRemoteUrl("ssh://git@bitbucket.example.com:7999/PROJ/service.git"), {
    kind: "server",
    baseUrl: "https://bitbucket.example.com",
    projectOrWorkspace: "PROJ",
    slug: "service",
  });
  assert.deepEqual(parseBitbucketRemoteUrl("git@bitbucket.org:team/service.git"), {
    kind: "cloud",
    baseUrl: "https://bitbucket.org",
    projectOrWorkspace: "team",
    slug: "service",
  });

  const serverRepo = resolveBitbucketRepo({ repo: "PROJ/service" }, undefined, "https://bitbucket.example.com");
  assert.equal(bitbucketApiUrl(serverRepo, "/pull-requests/12"), "https://bitbucket.example.com/rest/api/1.0/projects/PROJ/repos/service/pull-requests/12");

  const cloudRepo = resolveBitbucketRepo({ repo: "team/service" }, undefined, "https://bitbucket.org");
  assert.equal(bitbucketApiUrl(cloudRepo, "/pullrequests/12"), "https://api.bitbucket.org/2.0/repositories/team/service/pullrequests/12");
  assert.equal(parseSearchDateBound("2d", new Date("2026-06-13T12:00:00Z")), "2026-06-11");
});

test("bitbucket core formats PRs and creates Cloud/Server payloads", () => {
  const serverRepo = resolveBitbucketRepo({ repo: "PROJ/service" }, undefined, "https://bitbucket.example.com");
  const input = parseBitbucketInput(JSON.stringify({
    op: "pr_create",
    title: "Add feature",
    sourceBranch: "feature/demo",
    targetBranch: "main",
    reviewer: ["alice"],
  }));
  assert.deepEqual(bitbucketPrPayload(serverRepo, input), {
    title: "Add feature",
    description: "",
    fromRef: { id: "refs/heads/feature/demo", repository: { slug: "service", project: { key: "PROJ" } } },
    toRef: { id: "refs/heads/main", repository: { slug: "service", project: { key: "PROJ" } } },
    reviewers: [{ user: { name: "alice" } }],
  });

  assert.match(formatBitbucketPr(serverRepo, {
    id: 12,
    title: "Fix checkout",
    state: "OPEN",
    fromRef: { displayId: "feature/demo" },
    toRef: { displayId: "main" },
  }), /# PR 12: Fix checkout/);
  assert.match(unsupportedBitbucketOp("search_code", "use Alpha search"), /Unsupported bitbucket op 'search_code'/);
  assert.deepEqual(buildCheckoutMetadata(12, "feature/demo", "https://bitbucket/pull/12"), {
    remote: "origin",
    merge: "refs/heads/feature/demo",
    "alpha-bitbucket-pr": "12",
    "alpha-bitbucket-pr-head-ref": "feature/demo",
    "alpha-bitbucket-pr-url": "https://bitbucket/pull/12",
  });
  assert.deepEqual(applyBitbucketDateFilter([
    { title: "old", updated_on: "2026-06-10T00:00:00Z" },
    { title: "new", updated_on: "2026-06-12T00:00:00Z" },
  ], { since: "2026-06-11", until: undefined, dateField: "updated" }).map((item) => item.title), ["new"]);
});

test("bitbucket search_code follows OMP-style code search behavior", () => {
  const repo = resolveBitbucketRepo({ repo: "PROJ/service" }, undefined, "https://bitbucket.example.com");
  const input = parseBitbucketInput(JSON.stringify({ op: "search_code", query: "findThing", limit: 2 }));

  assert.equal(requireBitbucketCodeSearchQuery(input), "findThing");
  assert.throws(
    () => requireBitbucketCodeSearchQuery(parseBitbucketInput(JSON.stringify({ op: "search_code", query: "findThing", since: "3d" }))),
    /search_code does not support since\/until/,
  );

  assert.deepEqual(bitbucketCodeSearchUrls(repo, input, ["/custom/search?q={query}&repo={repo}&n={limit}"]), [
    "https://bitbucket.example.com/custom/search?q=findThing&repo=PROJ%2Fservice&n=2",
    "https://bitbucket.example.com/rest/search/latest/search?query=findThing&limit=2&project=PROJ&repository=service",
    "https://bitbucket.example.com/rest/search/latest/search?query=findThing&limit=2&projectKey=PROJ&repositorySlug=service",
    "https://bitbucket.example.com/rest/search/latest/search?query=findThing&limit=2&repo=PROJ%2Fservice",
  ]);

  const rawCodeSearchData = {
    values: [
      {
        path: { components: ["src", "lib.ts"] },
        repository: { project: { key: "PROJ" }, slug: "service" },
        commit: { hash: "abcdef1234567890" },
        links: { self: [{ href: "https://bitbucket.example.com/projects/PROJ/repos/service/browse/src/lib.ts" }] },
        hitContexts: [{ text: "function findThing(): void {\n  return;" }],
      },
    ],
  };
  const normalized = normalizeBitbucketCodeSearchResults(rawCodeSearchData);
  assert.deepEqual(normalized, [{
    path: "src/lib.ts",
    repo: "PROJ/service",
    commit: "abcdef1234567890",
    url: "https://bitbucket.example.com/projects/PROJ/repos/service/browse/src/lib.ts",
    match: "function findThing(): void {\n  return;",
  }]);

  const formatted = formatBitbucketCodeSearchResults(repo, "findThing", rawCodeSearchData, 2);
  assert.match(formatted, /# Bitbucket code search/);
  assert.match(formatted, /Query: findThing/);
  assert.match(formatted, /Repository: PROJ\/service/);
  assert.match(formatted, /- src\/lib\.ts/);
  assert.match(formatted, /  Repo: PROJ\/service/);
  assert.match(formatted, /  Commit: abcdef123456/);
  assert.match(formatted, /  Match: function findThing\(\): void \{ return;/);
});

test("read structural summaries cover OMP IaC file families", () => {
  const terraform = Array.from({ length: 90 }, (_, index) => {
    if (index === 0) return "terraform {";
    if (index === 8) return "provider \"aws\" {";
    if (index === 20) return "resource \"aws_s3_bucket\" \"logs\" {";
    if (index === 50) return "module \"network\" {";
    return `  # filler ${index}`;
  }).join("\n");
  const terraformSummary = structuralSummary("main.tf", terraform);
  assert.match(terraformSummary ?? "", /1:terraform \{/);
  assert.match(terraformSummary ?? "", /21:resource "aws_s3_bucket" "logs" \{/);

  const dockerfile = Array.from({ length: 85 }, (_, index) => {
    if (index === 0) return "FROM node:22";
    if (index === 10) return "WORKDIR /app";
    if (index === 20) return "COPY package.json .";
    if (index === 40) return "RUN npm ci";
    if (index === 70) return "CMD [\"node\", \"server.js\"]";
    return `# filler ${index}`;
  }).join("\n");
  const dockerSummary = structuralSummary("Dockerfile", dockerfile);
  assert.match(dockerSummary ?? "", /1:FROM node:22/);
  assert.match(dockerSummary ?? "", /41:RUN npm ci/);

  const helm = Array.from({ length: 90 }, (_, index) => {
    if (index === 0) return "{{- define \"app.name\" -}}";
    if (index === 12) return "apiVersion: apps/v1";
    if (index === 13) return "kind: Deployment";
    if (index === 30) return "{{- if .Values.service.enabled }}";
    return `{{/* filler ${index} */}}`;
  }).join("\n");
  const helmSummary = structuralSummary("templates/deployment.tpl", helm);
  assert.match(helmSummary ?? "", /1:\{\{- define "app.name" -\}\}/);
  assert.match(helmSummary ?? "", /13:apiVersion: apps\/v1/);
});

test("find core parses OMP-style input and clamps limits", () => {
  assert.deepEqual(parseFindInput(JSON.stringify({
    paths: ["src/**/*.ts", "test/**/*.mjs"],
    hidden: false,
    gitignore: false,
    limit: 500,
    timeout: 120,
  })), {
    paths: ["src/**/*.ts", "test/**/*.mjs"],
    hidden: false,
    gitignore: false,
    limit: 200,
    timeout: 60,
  });

  assert.deepEqual(findIncludeGlobs(parseFindInput(JSON.stringify({ paths: ["src", "package.json"] }))), ["src/**/*", "package.json"]);
  assert.match(findExcludeGlob({ hidden: false }), /\.\*/);
});

test("find core groups paths by directory and sorts by mtime", () => {
  const merged = mergeFindEntries([
    { path: "src/b.ts", mtime: 2 },
    { path: "README.md", mtime: 1 },
    { path: "src/a.ts", mtime: 3 },
    { path: "src/a.ts", mtime: 4 },
    { path: "src/tools/", mtime: 5 },
  ], 10);
  const rendered = renderFindResults(merged.entries, { limited: false, limit: 10 }).text;

  assert.deepEqual(merged.entries, ["src/tools/", "src/a.ts", "src/b.ts", "README.md"]);
  assert.match(rendered, /# src\//);
  assert.match(rendered, /tools\//);
  assert.match(rendered, /a\.ts/);
  assert.match(rendered, /README\.md/);
  assert.equal(matchesFindGlob("src/tools/", "src/**/*"), true);
});

test("find core reports limits and artifact spillover candidates", () => {
  const merged = mergeFindEntries([
    { path: "a.ts", mtime: 3 },
    { path: "b.ts", mtime: 2 },
  ], 1);
  const rendered = renderFindResults(merged.entries, { limited: merged.limited, limit: 1 }).text;
  const truncated = truncateFindOutput(`${rendered}\n${"z".repeat(500)}`, 120);

  assert.match(rendered, /Limited to the first 1 results/);
  assert.equal(truncated.truncated, true);
  assert.match(truncated.visible, /full output stored as artifact/);
});

test("tool discovery BM25 ranks matching discoverable tools", () => {
  const index = buildDiscoverableToolSearchIndex([
    {
      name: "find",
      label: "find",
      summary: "Find files and directories using paths globs.",
      source: "builtin",
      schemaKeys: ["paths", "hidden", "gitignore"],
    },
    {
      name: "write",
      label: "write",
      summary: "Create or replace complete content for a workspace file.",
      source: "builtin",
      schemaKeys: ["path", "content"],
    },
  ]);

  const results = searchDiscoverableTools(index, "find directories globs hidden gitignore", 2);

  assert.equal(results[0].tool.name, "find");
  assert.ok(results[0].score > 0);
});

test("search_tool_bm25 activates discoverable Alpha tools", async () => {
  const discoveredTools = new InMemoryDiscoveredToolStore();
  const ctx = makeToolContext({ discoveredTools });

  const result = await searchToolBm25Tool.run(JSON.stringify({ query: "find files directories paths gitignore", limit: 2 }), ctx);
  const parsed = JSON.parse(result.markdown);

  assert.equal(parsed.query, "find files directories paths gitignore");
  assert.equal(parsed.match_count > 0, true);
  assert.equal(parsed.total_tools > 0, true);
  assert.equal(discoveredTools.list().includes("find"), true);
  assert.equal(parsed.activated_tools.includes("find"), true);
});

test("search core parses raw and structured OMP-style input", () => {
  assert.deepEqual(parseSearchInput("TODO", { contextBefore: 2, contextAfter: 3, maxResults: 25 }), {
    pattern: "TODO",
    paths: [],
    regex: true,
    caseSensitive: true,
    gitignore: true,
    skip: 0,
    contextBefore: 2,
    contextAfter: 3,
    maxResults: 25,
  });

  assert.deepEqual(parseSearchInput(JSON.stringify({
    pattern: "value\\s*=\\s*1",
    paths: ["src", "test/**/*.ts"],
    i: true,
    contextBefore: 0,
    contextAfter: 0,
    skip: 3,
    maxResults: 2,
  })), {
    pattern: "value\\s*=\\s*1",
    paths: ["src", "test/**/*.ts"],
    regex: true,
    caseSensitive: false,
    gitignore: true,
    skip: 3,
    contextBefore: 0,
    contextAfter: 0,
    maxResults: 2,
  });

  assert.deepEqual(includeGlobsForSearch({ paths: ["src"] }), ["src/**/*"]);
  assert.deepEqual(includeGlobsForSearch({ paths: ["src/app.ts"] }), ["src/app.ts"]);
  assert.deepEqual(includeGlobsForSearch({ paths: ["src/**/*.ts"] }), ["src/**/*.ts"]);
});

test("search core renders grouped hashline anchors with match and context rows", () => {
  const input = parseSearchInput(JSON.stringify({
    pattern: "value",
    contextBefore: 1,
    contextAfter: 1,
    maxResults: 10,
  }));
  const result = searchText("src/demo.ts", "ABCD", "const before = 0;\nexport const value = 1;\nconst after = 2;\n", input, 10);

  const rendered = renderSearchResults([result], input, false).text;

  assert.match(rendered, /Search found 1 match in 1 file/);
  assert.match(rendered, /\[src\/demo\.ts#ABCD\]/);
  assert.match(rendered, / 1:const before = 0;/);
  assert.match(rendered, /\*2:export const value = 1;/);
  assert.match(rendered, / 3:const after = 2;/);
});

test("search core reports limited output and artifact spillover candidates", () => {
  const input = parseSearchInput(JSON.stringify({ pattern: "x", maxResults: 1, contextBefore: 0, contextAfter: 0 }));
  const result = searchText("src/demo.ts", "BEEF", "x\nx\n", input, 1);
  const rendered = renderSearchResults([result], input, true).text;
  const truncated = truncateSearchOutput(`${rendered}\n${"z".repeat(500)}`, 160);

  assert.match(rendered, /Limited to the first 1 match/);
  assert.equal(truncated.truncated, true);
  assert.match(truncated.visible, /full output stored as artifact/);
});

test("job exposes OMP-style async bash inspection", () => {
  const job = getAlphaToolRegistration("job");

  assert.equal(job.visibility, "public");
  assert.equal(job.loadMode, "discoverable");
  assert.equal(job.inputSchema.properties.list.type, "boolean");
  assert.equal(job.inputSchema.properties.poll.type, "array");
  assert.equal(job.inputSchema.properties.cancel.type, "array");
});

test("task exposes OMP-style batch subagent contract", () => {
  const task = getAlphaToolRegistration("task");

  assert.equal(task.visibility, "public");
  assert.equal(task.loadMode, "discoverable");
  assert.deepEqual(task.inputSchema.required, ["agent", "context", "tasks"]);
  assert.equal(task.inputSchema.properties.agent.type, "string");
  assert.equal(task.inputSchema.properties.context.type, "string");
  assert.equal(task.inputSchema.properties.tasks.type, "array");
  assert.deepEqual(task.inputSchema.properties.tasks.items.required, ["assignment"]);
  assert.equal(task.inputSchema.properties.tasks.items.properties.id.type, "string");
  assert.equal(task.inputSchema.properties.tasks.items.properties.description.type, "string");
  assert.equal(task.inputSchema.properties.tasks.items.properties.role.type, "string");
  assert.equal(task.inputSchema.properties.tasks.items.properties.assignment.type, "string");
  assert.equal(task.inputSchema.properties.tasks.items.properties.isolated.type, "boolean");
});

test("task validation matches OMP batch shape rules", () => {
  assert.equal(validateSpawnParams({}, true), "Missing `agent`. Provide an agent type to spawn.");
  assert.equal(validateSpawnParams({ agent: "task" }, true), "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`.");
  assert.match(validateShapeParams(false, { agent: "task", context: "ctx", tasks: [{ assignment: "Do work." }] }), /task\.batch is disabled/);
  assert.match(validateSpawnParams({
    agent: "task",
    context: "ctx",
    tasks: [{ id: "A", assignment: "One" }, { id: "a", assignment: "Two" }],
  }, true), /Duplicate task id/);
  assert.equal(validateSpawnParams({
    agent: "task",
    context: "ctx",
    tasks: [{ id: "A", role: "API specialist", assignment: "One" }],
  }, true), undefined);
});

test("task role propagates into spawn params and subagent prompt", () => {
  const params = {
    agent: "task",
    context: "Shared facts",
    tasks: [{ id: "A", role: "Rust async-runtime specialist", assignment: "Inspect scheduler." }],
  };
  const item = resolveSpawnItems(params)[0];
  const spawn = spawnParamsFor(params, item);
  const prompt = renderSubagentPrompt({
    name: "task",
    description: "General",
    systemPrompt: "Work carefully.",
    source: "bundled",
  }, spawn);

  assert.equal(spawn.role, "Rust async-runtime specialist");
  assert.match(prompt, /# Specialist Role/);
  assert.match(prompt, /Rust async-runtime specialist/);
  assert.match(prompt, /# Shared Context\nShared facts/);
});

test("task discovers OMP project agents before bundled agents", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "alpha-task-agents-"));
  const agentsDir = path.join(root, ".omp", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "task.md"), [
    "---",
    "name: task",
    "description: Project task override",
    "tools: [read, search]",
    "---",
    "Project-specific task prompt.",
    "",
  ].join("\n"));

  try {
    const discovered = await discoverAgents(root, path.join(root, "home"));

    assert.equal(discovered.projectAgentsDir, agentsDir);
    assert.equal(discovered.agents[0].name, "task");
    assert.equal(discovered.agents[0].description, "Project task override");
    assert.deepEqual(discovered.agents[0].tools, ["read", "search"]);
    assert.match(discovered.agents[0].systemPrompt, /Project-specific task prompt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task parses OMP-style agent frontmatter", () => {
  const agent = parseAgent("custom.md", [
    "---",
    "name: reviewer",
    "description: Custom reviewer",
    "tools: read, search, find",
    "spawns: *",
    "blocking: true",
    "output: {\"properties\":{\"ok\":{\"type\":\"boolean\"}}}",
    "---",
    "Review carefully.",
  ].join("\n"), "project");

  assert.equal(agent.name, "reviewer");
  assert.equal(agent.description, "Custom reviewer");
  assert.deepEqual(agent.tools, ["read", "search", "find"]);
  assert.equal(agent.spawns, "*");
  assert.equal(agent.blocking, true);
  assert.deepEqual(agent.output, { properties: { ok: { type: "boolean" } } });
  assert.match(agent.systemPrompt, /Review carefully/);
});

test("task validates structured agent output with OMP-style JTD schema", () => {
  const schema = {
    properties: {
      ok: { type: "boolean" },
      verdict: { enum: ["pass", "fail"] },
    },
    optionalProperties: {
      findings: {
        elements: {
          properties: {
            title: { type: "string" },
          },
        },
      },
    },
  };

  assert.equal(validateAgentOutput(JSON.stringify({ ok: true, verdict: "pass", findings: [{ title: "Good" }] }), schema).ok, true);
  const invalid = validateAgentOutput(JSON.stringify({ ok: "yes", verdict: "maybe" }), schema);
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /\$\.ok must be boolean/);
  assert.match(invalid.errors.join("\n"), /\$\.verdict must be one of/);
});

test("task summary surfaces validation errors and salvaged progress", () => {
  const rendered = renderTaskSummary({
    index: 0,
    id: "ReviewAPI",
    agent: "task",
    agentSource: "bundled",
    task: "Review API",
    assignment: "Review API",
    role: "API specialist",
    displayName: "API specialist",
    description: "Review API",
    exitCode: 1,
    output: "- read: src/api.ts looked relevant",
    stderr: "Output schema validation failed: $.ok must be boolean",
    truncated: false,
    durationMs: 1200,
    requests: 2,
  });

  assert.match(rendered, /Task ReviewAPI \(API specialist\) failed/);
  assert.match(rendered, /Role: API specialist/);
  assert.match(rendered, /Output schema validation failed/);
  assert.match(rendered, /Partial output/);
  assert.match(rendered, /src\/api\.ts looked relevant/);
});

test("task recursive spawning follows OMP-style depth and allowlist rules", () => {
  assert.equal(canSpawnAtDepth(2, 0), true);
  assert.equal(canSpawnAtDepth(2, 1), true);
  assert.equal(canSpawnAtDepth(2, 2), false);
  assert.equal(canSpawnAtDepth(-1, 200), true);

  assert.equal(isAgentSpawnAllowed("explore", "*"), true);
  assert.equal(isAgentSpawnAllowed("explore", ["explore"]), true);
  assert.equal(isAgentSpawnAllowed("task", ["explore"]), false);
  assert.equal(isAgentSpawnAllowed("explore", ""), false);

  assert.deepEqual(normalizeSpawnAllowance("*"), "*");
  assert.deepEqual(normalizeSpawnAllowance(["explore"]), ["explore"]);
  assert.equal(normalizeSpawnAllowance(undefined), "");

  assert.equal(validateSpawnPermission({
    agentName: "explore",
    allowedSpawns: ["explore"],
    taskDepth: 1,
    maxRecursionDepth: 2,
  }), undefined);
  assert.match(validateSpawnPermission({
    agentName: "task",
    allowedSpawns: ["explore"],
    taskDepth: 1,
    maxRecursionDepth: 2,
  }), /Allowed: explore/);
  assert.match(validateSpawnPermission({
    agentName: "reviewer",
    allowedSpawns: "*",
    blockedAgent: "reviewer",
    taskDepth: 1,
    maxRecursionDepth: 2,
  }), /recursion prevention/);
  assert.match(validateSpawnPermission({
    agentName: "explore",
    allowedSpawns: "*",
    taskDepth: 2,
    maxRecursionDepth: 2,
  }), /Maximum task recursion depth/);
});

test("task exposes child task tool only for spawn-capable agents and strips it in plan mode", () => {
  const agent = {
    name: "plan",
    description: "Planning",
    systemPrompt: "Plan.",
    tools: ["read", "search"],
    spawns: ["explore"],
    source: "bundled",
  };

  assert.deepEqual(agentToolNames({ agent, taskDepth: 0, maxRecursionDepth: 2 }), ["read", "search", "task"]);
  assert.deepEqual(agentToolNames({ agent, taskDepth: 2, maxRecursionDepth: 2 }), ["read", "search"]);
  assert.deepEqual(agentToolNames({ agent, taskDepth: 0, maxRecursionDepth: 2, planModeActive: true }), ["read", "search"]);

  const planModeAgent = agentForPlanMode({
    ...agent,
    tools: ["read", "search", "bash", "report_finding", "task"],
  });
  assert.equal(planModeAgent.spawns, undefined);
  assert.deepEqual(planModeAgent.tools, ["read", "search", "find", "lsp", "web_search", "report_finding"]);
  assert.match(planModeAgent.systemPrompt, /Plan mode active/);
});

test("task allocates OMP-style nested output ids under parent agents", () => {
  const existing = new Set(["Parent.Child", "Parent.Child2", "Other"]);

  assert.equal(allocateNestedTaskId("Child", existing, "Parent"), "Parent.Child3");
  assert.equal(allocateNestedTaskId("Review API", existing, "Parent"), "Parent.ReviewAPI");
  assert.equal(allocateNestedTaskId("Root", existing), "Root");
});

test("bundled reviewer agent mirrors OMP review contract", async () => {
  const discovered = await discoverAgents(process.cwd(), path.join(tmpdir(), "alpha-no-home"));
  const reviewer = discovered.agents.find((agent) => agent.name === "reviewer");

  assert.ok(reviewer);
  assert.equal(reviewer.blocking, true);
  assert.deepEqual(reviewer.tools, ["read", "search", "find", "bash", "lsp", "web_search", "report_finding", "yield"]);
  assert.match(reviewer.systemPrompt, /Call `report_finding` per issue/);
  assert.match(reviewer.systemPrompt, /Final `yield` data must include/);
  assert.deepEqual(reviewer.output.properties.overall_correctness.enum, ["correct", "incorrect"]);
});

test("review core parses diffs, filters noise, and builds OMP review prompt", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-export const value = 1;",
    "+export const value = 2;",
    "diff --git a/package-lock.json b/package-lock.json",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1 +1 @@",
    "-{}",
    "+{\"x\":1}",
  ].join("\n");

  const stats = parseDiff(diff);
  const prompt = buildReviewPrompt("Reviewing uncommitted changes (staged + unstaged)", stats, diff);

  assert.equal(stats.files.length, 1);
  assert.equal(stats.files[0].path, "src/app.ts");
  assert.equal(stats.excluded[0].path, "package-lock.json");
  assert.equal(stats.excluded[0].reason, "lock file");
  assert.equal(getRecommendedAgentCount(stats), 1);
  assert.match(prompt, /Use the `task` tool with `agent: "reviewer"`/);
  assert.match(prompt, /Call `report_finding` per issue/);
  assert.match(prompt, /<diff>/);
});

test("report_finding details convert to reviewer output priority ordinals", () => {
  const details = parseReportFindingDetails({
    title: "Handle null response",
    body: "A null API response reaches property access and throws.",
    priority: "P1",
    confidence: 0.9,
    file_path: "src/app.ts",
    line_start: 12,
    line_end: 13,
  });

  assert.ok(details);
  assert.equal(toReviewFinding(details).priority, 1);
});

test("commit core parses OMP-style commit flags", () => {
  assert.deepEqual(parseCommitCommandArgs("--dry-run --push --ticket smad-150 --context \"release fix\""), {
    dryRun: true,
    push: true,
    ticket: "SMAD-150",
    context: "release fix",
  });
  assert.deepEqual(parseCommitCommandArgs("auth boundary cleanup"), {
    dryRun: false,
    push: false,
    context: "auth boundary cleanup",
  });
  assert.equal(parseCommitCommandArgs("--ticket=SMAD-151").ticket, "SMAD-151");
  assert.throws(() => parseCommitCommandArgs("--ticket nope"), /Invalid ticket/);
});

test("commit core validates conventional single commit messages", () => {
  const invalid = validateCommitProposal({
    type: "fix",
    scope: "Auth",
    summary: "fix login bug.",
    details: [],
    issue_refs: [],
  }, ["src/auth.ts"]);

  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), /past-tense/);
  assert.match(invalid.errors.join("\n"), /period/);
  assert.match(invalid.errors.join("\n"), /lowercase/);

  const valid = validateCommitProposal({
    type: "fix",
    scope: "auth",
    summary: "Fixed expired token handling",
    details: [{ text: "Rejected expired tokens before session lookup." }],
    issue_refs: [],
  }, ["src/auth.ts"]);

  assert.equal(valid.valid, true);
  assert.equal(formatCommitMessage(valid.proposal), "fix(auth): Fixed expired token handling\n\n- Rejected expired tokens before session lookup.");
  assert.equal(formatCommitMessage(valid.proposal, { ticket: "SMAD-150" }), "SMAD-150: Fixed expired token handling\n\n- Rejected expired tokens before session lookup.");
});

test("commit core strips accidental ticket prefixes from model summaries", () => {
  const valid = validateCommitProposal({
    type: "fix",
    scope: "auth",
    summary: "SMAD-150: Fixed expired token handling",
    details: [],
    issue_refs: [],
  }, ["src/auth.ts"]);

  assert.equal(valid.valid, true);
  assert.equal(valid.proposal.summary, "Fixed expired token handling");
  assert.equal(formatCommitMessage(valid.proposal, { ticket: "SMAD-150" }), "SMAD-150: Fixed expired token handling");
});

test("commit core rejects split dependency cycles before execution", () => {
  const result = computeDependencyOrder([{ dependencies: [1] }, { dependencies: [0] }]);

  assert.deepEqual(result, { error: "Circular dependency detected in split commit plan." });
});

test("commit core validates split coverage and hunk selectors", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " export function a() {",
    "-  return 1;",
    "+  return 2;",
    " }",
    "diff --git a/src/b.ts b/src/b.ts",
    "index 3333333..4444444 100644",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,3 +1,3 @@",
    " export function b() {",
    "-  return 1;",
    "+  return 2;",
    " }",
  ].join("\n");

  const missing = validateSplitCommitPlan({
    commits: [
      { changes: [{ path: "src/a.ts", hunks: { type: "indices", indices: [2] } }], type: "fix", scope: null, summary: "Fixed invalid selector handling" },
      { changes: [{ path: "src/a.ts", hunks: { type: "all" } }], type: "fix", scope: null, summary: "Fixed duplicate split coverage" },
    ],
  }, ["src/a.ts", "src/b.ts"], diff);

  assert.equal(missing.valid, false);
  assert.match(missing.errors.join("\n"), /No hunks selected for src\/a\.ts/);
  assert.match(missing.errors.join("\n"), /File appears in multiple commits/);
  assert.match(missing.errors.join("\n"), /Staged file missing from split plan: src\/b\.ts/);

  const valid = validateSplitCommitPlan({
    commits: [
      { changes: [{ path: "src/a.ts", hunks: { type: "all" } }], type: "fix", scope: null, summary: "Fixed alpha calculation" },
      { changes: [{ path: "src/b.ts", hunks: { type: "all" } }], type: "fix", scope: null, summary: "Fixed beta calculation", dependencies: [0] },
    ],
  }, ["src/a.ts", "src/b.ts"], diff);

  assert.equal(valid.valid, true);
  assert.deepEqual(computeDependencyOrder(valid.proposal.commits), [0, 1]);
});

test("commit core extracts patches for hunk staging", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " export function a() {",
    "-  return 1;",
    "+  return 2;",
    " }",
  ].join("\n");
  const chunks = parseDiffChunks(diff);

  const patch = buildPatchForChange(chunks, { path: "src/a.ts", hunks: { type: "indices", indices: [1] } });

  assert.match(patch, /diff --git a\/src\/a\.ts b\/src\/a\.ts/);
  assert.match(patch, /@@ -1,3 \+1,3 @@/);
  assert.match(patch, /\+  return 2;/);
});

test("task description lists agents and Alpha host limitations", () => {
  const rendered = renderTaskDescription([
    { name: "explore", description: "Read-only scan", tools: ["read", "search"], systemPrompt: "", source: "bundled" },
    { name: "task", description: "General work", systemPrompt: "", spawns: "*", source: "bundled" },
  ], { asyncEnabled: true, batchEnabled: true, maxConcurrency: 4 });

  assert.match(rendered, /Spawns subagents to work in the background/);
  assert.match(rendered, /# explore - READ-ONLY/);
  assert.match(rendered, /recursively spawn child agents/);
  assert.match(rendered, /isolated git worktrees, IRC keep-alive/);
});

test("eval exposes OMP-style cells contract", () => {
  const evalTool = getAlphaToolRegistration("eval");

  assert.equal(evalTool.visibility, "public");
  assert.equal(evalTool.loadMode, "discoverable");
  assert.deepEqual(evalTool.inputSchema.required, ["cells"]);
  assert.equal(evalTool.inputSchema.properties.cells.type, "array");
  assert.deepEqual(evalTool.inputSchema.properties.cells.items.properties.language.enum, ["py", "js"]);
  assert.deepEqual(evalTool.inputSchema.properties.cells.items.required, ["language", "code"]);
  assert.equal(evalTool.inputSchema.properties.cells.items.properties.timeout.type, "number");
  assert.equal(evalTool.inputSchema.properties.cells.items.properties.reset.type, "boolean");
});

test("eval core validates and parses OMP-style input", () => {
  assert.deepEqual(parseEvalInput(JSON.stringify({
    cells: [{ language: "js", code: "const x = 1;", title: "setup", timeout: 5, reset: true }],
  })), {
    cells: [{ language: "js", code: "const x = 1;", title: "setup", timeout: 5, reset: true }],
  });
  assert.throws(() => validateEvalParams({ cells: [] }), /at least one cell/);
  assert.throws(() => validateEvalParams({ cells: [{ language: "rb", code: "1" }] }), /language/);
});

test("eval JS cells preserve state and expose display/tool helpers", async () => {
  const calls = [];
  const callbacks = makeEvalCallbacks({
    tool: async (name, args) => {
      calls.push({ name, args });
      return `tool:${name}:${JSON.stringify(args)}`;
    },
  });

  const result = await runEvalCells({
    cells: [
      { language: "js", code: "const x = 41; display({x});" },
      { language: "js", code: "console.log(x + 1); await tool.read({ path: 'demo.ts' });" },
    ],
  }, callbacks);

  assert.equal(result.isError, false);
  assert.match(result.output, /"x": 41/);
  assert.match(result.output, /42/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ name: "read", args: { path: "demo.ts" } }]);
});

test("eval reset clears the persistent JS VM", async () => {
  const callbacks = makeEvalCallbacks({ sessionKey: "reset-eval-test" });

  await runEvalCells({ cells: [{ language: "js", code: "const keep = 1;" }] }, callbacks);
  const reset = await runEvalCells({ cells: [{ language: "js", code: "keep", reset: true }] }, callbacks);

  assert.equal(reset.isError, true);
  assert.match(reset.output, /keep is not defined/);
});

test("resolve uses the hidden OMP-style action contract", () => {
  const resolve = getAlphaToolRegistration("resolve");

  assert.deepEqual(resolve.inputSchema.required, ["action", "reason"]);
  assert.deepEqual(resolve.inputSchema.properties.action.enum, ["apply", "refine", "discard"]);
});

test("plan mode exposes OMP-style read-only tool surface with resolve", () => {
  const ctx = makeToolContext({ planMode: createPlanModeState("inspect before editing") });
  const names = getAdvertisedAlphaLanguageModelTools({ ctx, includeDiscoverable: true, forceTools: ["resolve"] }).map((tool) => tool.name);

  assert.deepEqual(names, ["read", "search", "find", "web_search", "ask", "write", "lsp", "task", "resolve", "todo"]);
});

test("plan mode prompts OMP-style parallel explore subagents for broad planning", () => {
  const ctx = makeToolContext({ planMode: createPlanModeState("inspect before editing") });
  const prompt = planModeSystemPrompt(ctx);

  assert.match(prompt, /parallel `explore` subagents/);
  assert.match(prompt, /agent: "explore"/);
  assert.match(prompt, /execution spec, not a design doc/);
  assert.match(prompt, /fresh implementer/);
});

test("plan mode blocks workspace writes and allows local plan artifacts", () => {
  const ctx = makeToolContext({ planMode: createPlanModeState("draft a plan") });

  assert.doesNotThrow(() => assertPlanModeWriteAllowed("local://auth-refactor-plan.md", ctx));
  assert.throws(
    () => assertPlanModeWriteAllowed("src/app.ts", ctx),
    /Plan mode keeps the workspace read-only/,
  );
});

test("plan review can display an approved inactive plan for retry", () => {
  const state = createPlanModeState("draft a plan");
  state.active = false;
  state.pendingApproval = false;
  state.approvedPlan = "Goal: update hello.py safely.";
  state.approvedPlanPath = "local://alpha-plan.md";

  const rendered = renderPlanReview(state);

  assert.match(rendered, /Status: approved for implementation/);
  assert.match(rendered, /approve and implement as goal/);
  assert.match(rendered, /approve and implement/);
  assert.match(rendered, /refine: <change>/);
  assert.match(rendered, /Goal: update hello\.py safely/);
});

test("plan review distinguishes pending approval from retryable approved plan", () => {
  const pending = createPlanModeState("draft a plan");
  pending.pendingApproval = true;
  pending.approvedPlan = "Goal: pending.";

  const retryable = createPlanModeState("draft a plan");
  retryable.active = false;
  retryable.pendingApproval = false;
  retryable.approvedPlan = "Goal: retryable.";

  assert.match(renderPlanReview(pending), /Status: waiting for user approval/);
  assert.match(renderPlanReview(retryable), /Status: approved for implementation/);
  assert.doesNotMatch(renderPlanReview(retryable), /waiting for user approval/);
});

test("plan approval goal bridge detects goal approvals and preserves plan objective", () => {
  assert.equal(isPlanApprovalAsGoalPrompt("approve and implement as goal"), true);
  assert.equal(isPlanApprovalAsGoalPrompt("approved as a goal, go ahead"), true);
  assert.equal(isPlanApprovalAsGoalPrompt("approve and implement"), false);
  assert.equal(isPlanApprovalAsGoalPrompt("refine goal section"), false);

  const objective = buildPlanGoalObjective(
    "# Plan\n\n1. Read src/app.ts\n2. Edit tests",
    "local://alpha-plan.md",
    "approve and implement as goal",
  );

  assert.match(objective, /Implement the approved Alpha plan at local:\/\/alpha-plan\.md/);
  assert.match(objective, /# Plan/);
  assert.match(objective, /1\. Read src\/app\.ts/);
  assert.match(objective, /User approval message/);
  assert.match(objective, /approve and implement as goal/);
});

test("goal core matches OMP create resume complete drop semantics", () => {
  const created = createGoal(undefined, "Ship release", 100);
  assert.equal(created.enabled, true);
  assert.equal(created.goal.objective, "Ship release");
  assert.equal(created.goal.status, "active");
  assert.equal(created.goal.tokenBudget, 100);
  assert.equal(remainingTokens(created.goal), 100);

  assert.throws(
    () => createGoal(created, "Another goal"),
    /cannot create a new goal because this session already has a goal/,
  );

  const paused = { ...created, enabled: false, goal: { ...created.goal, status: "paused" } };
  const resumed = resumeGoal(paused);
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.goal.status, "active");

  const budgeted = updateGoalBudget(resumed, 50);
  assert.equal(budgeted.goal.tokenBudget, 50);

  const completed = completeGoal(budgeted);
  assert.equal(completed.enabled, false);
  assert.equal(completed.mode, "exiting");
  assert.equal(completed.reason, "completed");
  assert.equal(completed.goal.status, "complete");

  const dropped = dropGoal(created);
  assert.equal(dropped.status, "dropped");
});

test("goal prompt and command parsing follow OMP-style objective contract", () => {
  const state = createGoalState("Fix <auth> & ship", 100);
  const prompt = goalModeSystemPrompt(state);

  assert.match(prompt, /Goal mode is active/);
  assert.match(prompt, /Fix &lt;auth&gt; &amp; ship/);
  assert.match(prompt, /hidden `goal` tool/);
  assert.match(prompt, /Budget exhaustion is not completion/);
  assert.match(prompt, /Treat natural follow-ups like `continue`/);
  assert.deepEqual(parseGoalCommand("status"), { op: "get" });
  assert.deepEqual(parseGoalCommand("resume"), { op: "resume" });
  assert.deepEqual(parseGoalCommand("complete"), { op: "complete" });
  assert.deepEqual(parseGoalCommand("drop"), { op: "drop" });
  assert.deepEqual(parseGoalCommand("budget 1200"), { op: "budget", tokenBudget: 1200 });
  assert.deepEqual(parseGoalCommand("set Improve Glue runtime"), { op: "create", objective: "Improve Glue runtime" });
});

test("goal continuation hint only appears for active unfinished goals", () => {
  const active = createGoalState("Ship Alpha");
  const completed = completeGoal(active);
  const paused = { ...active, enabled: false, goal: { ...active.goal, status: "paused" } };

  assert.equal(isGoalContinuationActive(active), true);
  assert.equal(isGoalContinuationActive(completed), false);
  assert.equal(isGoalContinuationActive(paused), false);
  assert.match(renderGoalContinuationHint(active), /reply naturally/);
  assert.match(renderGoalContinuationHint(active), /keep going/);
  assert.equal(renderGoalContinuationHint(completed), "");
  assert.equal(renderGoalContinuationHint(paused), "");
});

test("goal tool mutates persisted context through setGoalMode", async () => {
  let goalMode;
  const ctx = makeToolContext();
  ctx.setGoalMode = (state) => {
    goalMode = state;
    ctx.goalMode = state;
  };

  const created = await goalTool.run(JSON.stringify({ op: "create", objective: "Ship Alpha", token_budget: 25 }), ctx);
  assert.match(created.markdown, /Goal: Ship Alpha/);
  assert.equal(goalMode.goal.status, "active");
  assert.equal(goalMode.goal.tokenBudget, 25);

  const got = await goalTool.run(JSON.stringify({ op: "get" }), ctx);
  assert.match(got.markdown, /Remaining tokens: 25/);

  const completed = await goalTool.run(JSON.stringify({ op: "complete" }), ctx);
  assert.match(completed.markdown, /Status: complete/);
  assert.equal(goalMode.goal.status, "complete");

  const dropped = await goalTool.run(JSON.stringify({ op: "drop" }), ctx);
  assert.match(dropped.markdown, /Status: dropped/);
  assert.equal(goalMode, undefined);
});

test("system prompt injects active goal context and forced goal tool", () => {
  const ctx = makeToolContext({ goalMode: createGoalState("Complete the migration") });
  const prompt = buildAlphaSystemPrompt(ctx, { ctx, forceTools: ["goal"] });

  assert.match(prompt, /# Goal Mode/);
  assert.match(prompt, /Complete the migration/);
  assert.match(prompt, /`goal`: Manage the active OMP-style goal-mode objective/);
});


test("tool descriptions steer existing-file changes to edit over write", () => {
  const edit = getAlphaToolRegistration("edit");
  const write = getAlphaToolRegistration("write");

  assert.match(edit.description, /Default tool for modifying existing files/);
  assert.match(write.description, /Do not use for routine edits/);
});

test("system prompt includes OMP-style tool priority", () => {
  const prompt = buildAlphaSystemPrompt();

  assert.match(prompt, /# Tool Priority/);
  assert.match(prompt, /terminal work.*`bash`/);
  assert.match(prompt, /artifact:\/\/\.\.\./);
  assert.match(prompt, /surgical existing-file edits -> `edit`, not `write`/);
  assert.match(prompt, /mutation results include a concise diagnostics summary/);
  assert.match(prompt, /Merge conflicts: read `<path>:conflicts`/);
  assert.match(prompt, /conflict:\/\/<N>/);
  assert.match(prompt, /file\/dir reads -> `read`/);
  assert.match(prompt, /user clarification\/input -> `ask`/);
  assert.match(prompt, /# Ask/);
  assert.match(prompt, /Default to action/);
  assert.match(prompt, /per-chat shell session state/);
  assert.match(prompt, /Use `job` to list or inspect background bash jobs/);
  assert.match(prompt, /cancel: \[id\]/);
  assert.match(prompt, /Search output is grouped by file with editable headers/);
  assert.match(prompt, /`pattern` as the regex/);
  assert.match(prompt, /grep, rg, ripgrep/);
  assert.match(prompt, /Use `find` for every file-name lookup/);
  assert.match(prompt, /grouped by directory/);
  assert.match(prompt, /Use `lsp` for symbol-aware operations/);
  assert.match(prompt, /Bitbucket repository, pull-request, and remote code-search workflows -> `bitbucket`/);
  assert.match(prompt, /# Bitbucket/);
  assert.match(prompt, /BITBUCKET_TOKEN/);
  assert.match(prompt, /pr:\/\/<N>\/diff/);
  assert.match(prompt, /\.alpha\/worktrees\/alpha-pr-<N>/);
  assert.match(prompt, /Use `search_tool_bm25` only to find Alpha tools/);
  assert.match(prompt, /Public `task` shape follows OMP batch mode/);
  assert.match(prompt, /Subagents have no conversation history/);
  assert.match(prompt, /Alpha host limitation: `isolated`/);
  assert.match(prompt, /Public `eval` shape follows OMP/);
  assert.match(prompt, /Python runs in a subprocess backend/);
  assert.match(prompt, /`completion\(\)` and `agent\(\)` inside eval are not available yet/);
});

test("file snapshot store records four-character tags", () => {
  const snapshots = new InMemoryFileSnapshotStore();
  const first = snapshots.record("src/a.ts", "export const value = 1;\n");

  assert.match(first.tag, /^[A-F0-9]{4}$/);
  assert.equal(snapshots.has("src/a.ts", first.tag), true);
  assert.equal(snapshots.get("src/a.ts", first.tag)?.content, "export const value = 1;\n");
});

test("artifact store uses OMP-style numeric file-backed artifacts", async () => {
  const artifactDir = mkdtempSync(path.join(tmpdir(), "alpha-artifacts-"));
  try {
    const fullOutput = `line 1\n${"x".repeat(10000)}\nline 3\n`;
    const store = new InMemoryArtifactStore([], () => undefined, artifactDir);
    const artifact = store.add("bash output", fullOutput);

    assert.equal(artifact.id, "0");
    assert.equal(artifact.content, "");
    assert.equal(readFileSync(artifact.filePath, "utf8"), fullOutput);
    assert.equal(store.list()[0].content, "");

    assert.equal(store.get("0").content, fullOutput);

    const restored = new InMemoryArtifactStore(store.list(), () => undefined, artifactDir);
    assert.equal(restored.get("0").content, fullOutput);
    assert.equal(restored.add("bash output", "next").id, "1");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("agent URL JSON path helpers support dot and slash extraction", () => {
  const data = { findings: [{ path: "src/app.ts", confidence: 0.9, "special-key": ["ok"] }] };

  assert.deepEqual(parseJsonPath("findings.0.path"), ["findings", 0, "path"]);
  assert.deepEqual(parseJsonPath(".findings[0]['special-key'][0]"), ["findings", 0, "special-key", 0]);
  assert.equal(applyJsonPath(data, "findings.0.path"), "src/app.ts");
  assert.equal(applyJsonPath(data, ".findings[0].path"), "src/app.ts");
  assert.equal(applyJsonPath(data, ".findings[0]['special-key'][0]"), "ok");
  assert.equal(applyJsonPath(data, "findings/0/confidence"), 0.9);
  assert.equal(applyJsonPath(data, "findings.1.path"), undefined);
});

test("conflict core registers and resolves OMP-style conflict URLs", () => {
  const text = [
    "prefix",
    "<<<<<<< HEAD",
    "ours",
    "=======",
    "theirs",
    ">>>>>>> feature",
    "suffix",
  ].join("\n");
  const store = new InMemoryConflictStore();
  const [block] = scanConflictLines(text.split("\n"), 1, "app.py", "app.py");
  const entry = store.register(block);

  assert.deepEqual(parseConflictUri("conflict://1"), { id: 1 });
  assert.deepEqual(parseConflictUri("app.py:conflict://1/theirs"), {
    id: 1,
    scope: "theirs",
    recoveredPrefix: "app.py",
  });
  assert.equal(store.register(block).id, entry.id);
  assert.deepEqual(renderConflictRegion(entry, "theirs"), { lines: ["theirs"], startLine: 5 });
  assert.equal(expandConflictTokens("@theirs", entry), "theirs");
  assert.equal(spliceConflict(text, entry, expandConflictTokens("@theirs", entry)), "prefix\ntheirs\nsuffix");
});

test("conflict core supports diff3 base sections and rejects invalid conflict URLs", () => {
  const text = [
    "<<<<<<< ours",
    "ours body",
    "||||||| base",
    "base body",
    "=======",
    "theirs body",
    ">>>>>>> theirs",
  ].join("\n");
  const store = new InMemoryConflictStore();
  const [block] = scanConflictLines(text.split("\n"), 20, "merge.txt", "merge.txt");
  const entry = store.register(block);

  assert.deepEqual(renderConflictRegion(entry, "base"), { lines: ["base body"], startLine: 23 });
  assert.equal(spliceConflict(text, entry, expandConflictTokens("@base", entry)), "base body");
  assert.throws(() => parseConflictUri("conflict://*/ours"), /wildcard/);
  assert.throws(() => parseConflictUri("conflict://0"), /id must be >= 1/);
});

test("approval modes follow OMP tier comparisons", () => {
  assert.deepEqual(resolveApproval({ name: "read", approval: "read" }, {}, "always-ask"), {
    policy: "allow",
    tier: "read",
    override: false,
  });
  assert.deepEqual(resolveApproval({ name: "write", approval: "write" }, {}, "always-ask"), {
    policy: "prompt",
    tier: "write",
    override: false,
  });
  assert.deepEqual(resolveApproval({ name: "bash", approval: "exec" }, {}, "write"), {
    policy: "prompt",
    tier: "exec",
    override: false,
  });
  assert.deepEqual(resolveApproval({ name: "bash", approval: "exec" }, {}, "yolo"), {
    policy: "allow",
    tier: "exec",
    override: false,
  });
});

test("approval per-tool policy overrides match OMP behavior", () => {
  assert.deepEqual(resolveApproval({ name: "bash", approval: "exec" }, {}, "yolo", { bash: "deny" }), {
    policy: "deny",
    tier: "exec",
    override: false,
  });
  assert.deepEqual(resolveApproval({ name: "bash", approval: "exec" }, {}, "yolo", { bash: "prompt" }), {
    policy: "prompt",
    tier: "exec",
    override: false,
  });
});

test("approval tool tier mapping matches current and planned OMP tools", () => {
  assert.equal(bashApproval({ command: "npm test" }), "exec");
  assert.equal(taskApproval({ agent: "task" }), "exec");
  assert.equal(evalApproval({ cells: [{ language: "js", code: "1 + 1" }] }), "exec");
  assert.deepEqual(bashApproval({ command: "sudo rm -rf /tmp/nope" }), {
    tier: "exec",
    override: true,
    reason: "Critical pattern detected",
  });
  assert.equal(editApproval({ input: "[src/a.ts#ABCD]\nreplace 1..1:\n+x" }), "write");
  assert.equal(editApproval({ input: "[local://PLAN.md#ABCD]\nreplace 1..1:\n+x" }), "read");
  assert.equal(writeApproval({ path: "src/a.ts", content: "x" }), "write");
  assert.equal(writeApproval({ path: "local://PLAN.md", content: "x" }), "read");
  assert.equal(sshApproval({}), "exec");
  assert.equal(browserApproval({}), "exec");
  assert.equal(webSearchApproval({}), "read");
  assert.equal(askApproval({}), "read");
  assert.equal(bitbucketApproval({ op: "pr_view" }), "read");
  assert.equal(bitbucketApproval({ op: "pr_create" }), "exec");
  assert.equal(lspApproval({ action: "references" }), "read");
  assert.equal(lspApproval({ action: "rename" }), "write");
});

test("job tool lists and polls async bash jobs", async () => {
  const bashJobs = new InMemoryBashJobStore();
  const running = bashJobs.add({
    type: "bash",
    command: "npm test",
    cwd: "/workspace",
    status: "running",
  });
  const completed = bashJobs.add({
    type: "bash",
    command: "echo done",
    cwd: "/workspace",
    status: "completed",
    output: "done\n",
    exitCode: 0,
    artifactId: "7",
    wallTimeMs: 42,
  });
  const ctx = makeToolContext({ bashJobs });

  const listed = await jobTool.run(JSON.stringify({ list: true }), ctx);
  assert.match(listed.markdown, new RegExp(running.id));
  assert.match(listed.markdown, new RegExp(completed.id));
  assert.match(listed.markdown, /artifact:\/\/7/);

  const polled = await jobTool.run(JSON.stringify({ poll: [completed.id] }), ctx);
  assert.match(polled.markdown, /Completed/);
  assert.match(polled.markdown, /done/);
});

test("job tool cancels running async bash jobs", async () => {
  const bashJobs = new InMemoryBashJobStore();
  const running = bashJobs.add({
    type: "bash",
    command: "sleep 60",
    cwd: "/workspace",
    status: "running",
  });
  const ctx = makeToolContext({ bashJobs });

  const cancelled = await jobTool.run(JSON.stringify({ cancel: [running.id] }), ctx);

  assert.match(cancelled.markdown, /Cancelled/);
  assert.equal(bashJobs.get(running.id)?.status, "cancelled");
});

test("read adapter parses OMP-style archive and sqlite targets", () => {
  assert.deepEqual(splitArchiveTarget("data/bundle.tar.gz:src/index.ts"), {
    archivePath: "data/bundle.tar.gz",
    memberPath: "src/index.ts",
  });
  assert.deepEqual(splitArchiveTarget("pkg.zip"), {
    archivePath: "pkg.zip",
    memberPath: "",
  });
  assert.deepEqual(splitSqliteTarget("data/app.sqlite:users"), {
    dbPath: "data/app.sqlite",
    selector: "users",
  });
  assert.deepEqual(splitSqliteTarget("data/app.db?q=select%201"), {
    dbPath: "data/app.db",
    selector: "?q=select%201",
  });
});

test("web_search core parses DuckDuckGo HTML into OMP-style sources", () => {
  const input = parseWebSearchInput({ query: "alpha harness", recency: "week", limit: 2 });
  assert.equal(input.query, "alpha harness");
  assert.equal(input.recency, "week");
  assert.match(duckDuckGoHtmlUrl(input), /html\.duckduckgo\.com\/html\/\?q=alpha\+harness&df=w/);

  const html = `
    <html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Example &amp; Docs</a>
        <a class="result__snippet">Official docs snippet</a>
      </div>
    </body></html>`;
  const sources = parseDuckDuckGoHtml(html, 10);
  assert.deepEqual(sources, [{
    title: "Example & Docs",
    url: "https://example.com/doc",
    snippet: "Official docs snippet",
  }]);
  assert.match(formatWebSearchForLlm({ provider: "duckduckgo_html", sources, searchQueries: ["alpha harness"] }), /\[1\] Example & Docs/);
});

test("ask core parses OMP-style questions and formats answers", () => {
  const parsed = parseAskInput(JSON.stringify({
    questions: [{
      id: "auth_method",
      question: "Which authentication method?",
      options: [
        { label: "JWT", description: "Stateless API clients." },
        { label: "Session cookies" },
      ],
      recommended: 0,
    }],
  }));

  assert.equal(parsed.questions[0].id, "auth_method");
  assert.equal(optionLabelForDisplay(parsed.questions[0].options[0], 0, 0), `JWT${ASK_RECOMMENDED_SUFFIX}`);
  assert.equal(stripRecommendedSuffix(`JWT${ASK_RECOMMENDED_SUFFIX}`), "JWT");
  assert.equal(ASK_OTHER_OPTION, "Other (type your own)");
  assert.equal(formatAskResult([{
    id: "auth_method",
    question: "Which authentication method?",
    options: ["JWT", "Session cookies"],
    multi: false,
    selectedOptions: ["JWT"],
  }]), "User selected: JWT");
});

test("ask core formats multi-question answers", () => {
  assert.equal(formatAskResult([
    {
      id: "storage",
      question: "Storage?",
      options: ["SQLite", "PostgreSQL"],
      multi: false,
      selectedOptions: ["SQLite"],
    },
    {
      id: "extras",
      question: "Extras?",
      options: ["Metrics", "Tracing"],
      multi: true,
      selectedOptions: ["Metrics"],
      customInput: "Also add logs",
    },
  ]), "User answers:\n- storage: SQLite\n- extras: Metrics; custom: Also add logs");
});

test("read adapter converts fetched HTML URLs into markdown-like reader text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<html><head><title>Example Page</title></head><body><main><h1>Hello</h1><p>Read <a href='/docs'>docs</a>.</p></main></body></html>",
    { status: 200, headers: { "content-type": "text/html" } },
  );
  try {
    const result = await readWebUrl("https://example.com/page", false);
    assert.equal(result.label, "https://example.com/page (text/html)");
    assert.match(result.content, /# Example Page/);
    assert.match(result.content, /# Hello/);
    assert.match(result.content, /docs \(https:\/\/example.com\/docs\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read adapter converts notebooks into editable cell text", () => {
  const notebook = Buffer.from(JSON.stringify({
    cells: [
      { cell_type: "markdown", source: ["# Title\n", "body"] },
      { cell_type: "code", source: "print(1)\n", outputs: [{ text: "1" }] },
    ],
  }));

  assert.equal(notebookToText(notebook), "# %% [markdown] cell:1\n# Title\nbody\n# %% [code] cell:2\nprint(1)\n\n# outputs: 1");
});

test("read adapter reports image metadata without dumping binary content", () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02,
    0x00, 0x00, 0x00, 0x03,
    0x08, 0x06, 0x00, 0x00, 0x00,
  ]);

  assert.deepEqual(readImageMetadata("image.png", png), {
    format: "PNG",
    mime: "image/png",
    width: 2,
    height: 3,
    bytes: png.byteLength,
    alpha: true,
    channels: 4,
  });
});

test("read adapter reads tar archive listings and text members", async () => {
  const tar = makeTar([
    ["src/index.ts", "export const value = 1;\n"],
    ["README.md", "# Demo\n"],
  ]);

  const listing = await readArchiveTarget("bundle.tar", tar, "");
  assert.match(listing.content, /file README\.md/);
  assert.match(listing.content, /dir  src\//);

  const member = await readArchiveTarget("bundle.tar", tar, "src/index.ts");
  assert.equal(member.content, "export const value = 1;\n");
});

test("read adapter builds structural summaries for large source files", () => {
  const content = Array.from({ length: 120 }, (_, index) => {
    if (index === 4) return "import x from 'x';";
    if (index === 30) return "export function first() {";
    if (index === 80) return "class Second {";
    return `const line${index} = ${index};`;
  }).join("\n");

  const summary = structuralSummary("src/demo.ts", content);

  assert.match(summary ?? "", /5:import x from 'x';/);
  assert.match(summary ?? "", /31:export function first/);
  assert.match(summary ?? "", /81:class Second/);
  assert.match(summary ?? "", /structural summary/);
});

test("write adapter parses OMP-style archive and sqlite write targets", () => {
  assert.deepEqual(parseArchiveWriteTarget("bundle.zip:src/index.ts"), {
    archivePath: "bundle.zip",
    memberPath: "src/index.ts",
  });
  assert.deepEqual(parseSqliteWriteTarget("data/app.sqlite:users:42"), {
    dbPath: "data/app.sqlite",
    table: "users",
    key: "42",
  });
  assert.throws(() => normalizeArchiveSubPath("../escape.txt"), /cannot contain/);
  assert.throws(() => parseSqliteWriteTarget("data/app.sqlite?q=select%201"), /query parameters/);
});

test("write adapter rewrites tar archive members while preserving existing files", async () => {
  const initial = makeTar([
    ["src/index.ts", "export const value = 1;\n"],
    ["README.md", "# Demo\n"],
  ]);

  const next = await writeArchiveEntry("bundle.tar", initial, "src/index.ts", "export const value = 2;\n");
  const updated = await readArchiveTarget("bundle.tar", next, "src/index.ts");
  const preserved = await readArchiveTarget("bundle.tar", next, "README.md");

  assert.equal(updated.content, "export const value = 2;\n");
  assert.equal(preserved.content, "# Demo\n");
});

test("write adapter creates zip archives that the read adapter can read", async () => {
  const zip = await writeArchiveEntry("bundle.zip", undefined, "src/index.ts", "export const value = 1;\n");
  const member = await readArchiveTarget("bundle.zip", zip, "src/index.ts");

  assert.equal(member.content, "export const value = 1;\n");
});

function makeTar(files) {
  const chunks = [];
  for (const [name, content] of files) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, "ascii");
    header.fill(" ", 148, 156);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    chunks.push(header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function makeToolContext(overrides = {}) {
  return {
    artifacts: new InMemoryArtifactStore(),
    bashJobs: new InMemoryBashJobStore(),
    conflicts: new InMemoryConflictStore(),
    discoveredTools: new InMemoryDiscoveredToolStore(),
    pendingEdits: new InMemoryPendingEditStore(),
    permissionDecisions: new InMemoryPermissionDecisionStore(),
    snapshots: new InMemoryFileSnapshotStore(),
    todos: new InMemoryTodoStore(),
    token: { isCancellationRequested: false },
    ...overrides,
  };
}

function makeEvalCallbacks(overrides = {}) {
  return {
    cwd: tmpdir(),
    sessionKey: `eval-test-${Math.random().toString(36).slice(2)}`,
    read: async (target) => `read:${target}`,
    write: async (target, content) => `write:${target}:${content.length}`,
    append: async (target, content) => `append:${target}:${content.length}`,
    tree: async (target) => `tree:${target}`,
    tool: async (name, args) => `tool:${name}:${JSON.stringify(args)}`,
    env: (key, value) => {
      if (key === undefined) return {};
      if (value === undefined) return undefined;
      return value;
    },
    ...overrides,
  };
}
