import * as vscode from "vscode";
import { applyWorkspaceEdits } from "./patch/hashline";
import { AlphaSessionManager } from "./sessionState";
import type { AlphaSessionState } from "./sessionState";
import { buildAlphaTranscript } from "./transcript";
import type { AlphaTranscriptEntry } from "./transcript";
import type { AlphaContext } from "./types";
import { alphaContextUsageForPrompt, answerWithAlphaTools } from "./lmTools";
import {
  appendBlueprintAnswer,
  buildBlueprintGeneratePrompt,
  createBlueprintModeState,
  deactivateBlueprintMode,
  isBlueprintGeneratePrompt,
  parseBlueprintTemplate,
  parseBlueprintTemplateSelection,
  renderBlueprintTemplateQuestion,
  renderBlueprintStatus,
  setBlueprintTemplate,
} from "./blueprintMode";
import { runAlphaCommit } from "./commitWorkflow";
import { compactTranscriptWithModel, compactableTranscriptEntries, formatContextUsage } from "./contextManager";
import {
  completeGoal,
  createGoal,
  dropGoal,
  goalToolResponse,
  parseGoalCommand,
  pauseGoal,
  renderGoalStatus,
  renderGoalToolResponse,
  replaceGoal,
  resumeGoal,
  updateGoalBudget,
} from "./goalMode";
import { resolveInternalUrl } from "./internalUrls";
import {
  buildPlanGoalObjective,
  buildPlanOpenQuestionsPrompt,
  createPlanModeState,
  isPlanApprovalAsGoalPrompt,
  isPlanOpenQuestionsPrompt,
  renderPlanModeStatus,
  renderPlanReview,
} from "./planMode";
import { buildInteractiveReviewPrompt } from "./reviewCore";
import { workspaceRoot } from "./workspace";

let sessions: AlphaSessionManager;
let alphaPanelTerminal: vscode.Terminal | undefined;
let alphaEditorTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext): void {
  sessions = new AlphaSessionManager(context);
  const participant = vscode.chat.createChatParticipant("alpha.participant", async (request, chatContext, stream, token) => {
    await handleAlphaRequest(context, request, chatContext, stream, token);
  });
  participant.iconPath = new vscode.ThemeIcon("hubot");

  context.subscriptions.push(
    participant,
    vscode.commands.registerCommand("alpha.openPendingEdits", async () => {
      const session = sessions.latest();
      const edits = session?.pendingEdits.list() ?? [];
      if (!edits.length) {
        void vscode.window.showInformationMessage("Alpha has no pending edits.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        edits.map((edit) => ({
          label: edit.id,
          description: `${edit.edits.length} change(s)`,
          detail: edit.label,
          edit,
        })),
        { title: "Alpha Pending Edits" },
      );
      if (picked) {
        void vscode.window.showInformationMessage(`${picked.label}: ${picked.detail}`);
      }
    }),
    vscode.commands.registerCommand("alpha.applyPendingEdit", async () => {
      const session = sessions.latest();
      const edits = session?.pendingEdits.list() ?? [];
      if (!edits.length) {
        void vscode.window.showInformationMessage("Alpha has no pending edits.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        edits.map((edit) => ({
          label: edit.id,
          description: `${edit.edits.length} change(s)`,
          detail: edit.label,
          edit,
        })),
        { title: "Apply Alpha Pending Edit" },
      );
      if (!picked) return;
      const ok = await applyWorkspaceEdits(picked.edit.edits);
      if (ok) {
        session?.pendingEdits.remove(picked.edit.id);
        void vscode.window.showInformationMessage(`Applied ${picked.edit.id}.`);
      } else {
        void vscode.window.showErrorMessage(`VS Code rejected ${picked.edit.id}.`);
      }
    }),
    vscode.commands.registerCommand("alpha.clearPendingEdits", () => {
      sessions.latest()?.pendingEdits.clear();
      void vscode.window.showInformationMessage("Cleared Alpha pending edits.");
    }),
    vscode.commands.registerCommand("alpha.openTerminal", () => openAlphaTerminal(context, "panel")),
    vscode.commands.registerCommand("alpha.openTerminalInEditor", () => openAlphaTerminal(context, "editor")),
    vscode.commands.registerCommand("alpha.inspectVsCodeTools", () => {
      const output = vscode.window.createOutputChannel("Alpha: VS Code LM Tools");
      output.clear();
      output.appendLine(`VS Code LM tools visible to Alpha: ${vscode.lm.tools.length}`);
      output.appendLine("");

      if (!vscode.lm.tools.length) {
        output.appendLine("No tools are currently registered in vscode.lm.tools.");
        output.appendLine("If browser tools are enabled only inside Copilot's built-in agent, they may not be exposed to third-party chat participants.");
      }

      for (const tool of vscode.lm.tools) {
        output.appendLine(`- ${tool.name}`);
        if (tool.tags.length) output.appendLine(`  tags: ${tool.tags.join(", ")}`);
        if (tool.description) output.appendLine(`  description: ${tool.description}`);
        if (tool.inputSchema) output.appendLine(`  inputSchema: ${JSON.stringify(tool.inputSchema)}`);
        output.appendLine("");
      }

      const browserTools = vscode.lm.tools.filter((tool) => {
        const text = `${tool.name} ${tool.description} ${tool.tags.join(" ")}`.toLowerCase();
        return text.includes("browser") || text.includes("page") || text.includes("playwright");
      });
      output.appendLine(`Likely browser/page/playwright tools: ${browserTools.length ? browserTools.map((tool) => tool.name).join(", ") : "(none)"}`);
      output.show(true);
    }),
  );
}

export function deactivate(): void {
  sessions.persistNow();
}

async function openAlphaTerminal(context: vscode.ExtensionContext, location: "panel" | "editor"): Promise<void> {
  const existing = location === "panel" ? alphaPanelTerminal : alphaEditorTerminal;
  if (existing) {
    existing.show();
    return;
  }

  const model = await selectAlphaTerminalModel();
  if (!model) return;
  const pty = new AlphaPseudoTerminal(context, model);
  const terminal = vscode.window.createTerminal({
    name: location === "editor" ? "Alpha Editor" : "Alpha",
    iconPath: new vscode.ThemeIcon("hubot"),
    isTransient: false,
    location: location === "editor"
      ? { viewColumn: vscode.ViewColumn.Beside }
      : vscode.TerminalLocation.Panel,
    pty,
  });

  if (location === "panel") {
    alphaPanelTerminal = terminal;
  } else {
    alphaEditorTerminal = terminal;
  }

  const disposeClose = vscode.window.onDidCloseTerminal((closed) => {
    if (closed === terminal) {
      if (location === "panel") {
        alphaPanelTerminal = undefined;
      } else {
        alphaEditorTerminal = undefined;
      }
      disposeClose.dispose();
    }
  });
  context.subscriptions.push(disposeClose);
  terminal.show();
}

class AlphaPseudoTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private input = "";
  private history: string[] = [];
  private historyIndex: number | undefined;
  private busy = false;
  private cancellation: vscode.CancellationTokenSource | undefined;
  private sessionKey: string | undefined;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly model: vscode.LanguageModelChat,
  ) {}

  open(): void {
    const session = this.currentSession();
    this.writeLine(`Alpha terminal 0.0.1`);
    this.writeLine(`Model: ${this.model.name}`);
    this.writeLine(`Session: ${session.label}`);
    this.writeLine("Type `help`, `/sessions`, `/new`, `/resume`, `/context`, `/plan <goal>`, `/goal`, `/compact`, `/review`, or a natural request.");
    this.writeLine("Type `exit` to close this terminal.");
    this.writeLine("");
    this.prompt();
  }

  close(): void {
    this.cancellation?.cancel();
    this.cancellation?.dispose();
  }

  handleInput(data: string): void {
    if (data === "\x03") {
      this.cancelCurrentRequest();
      return;
    }
    if (this.busy) return;

    if (data === "\x1b[A") {
      this.replaceInput(this.previousHistory());
      return;
    }
    if (data === "\x1b[B") {
      this.replaceInput(this.nextHistory());
      return;
    }

    for (const char of data) {
      if (char === "\r") {
        void this.submitInput();
      } else if (char === "\x7f") {
        this.backspace();
      } else if (char >= " " || char === "\t") {
        this.input += char;
        this.write(char);
      }
    }
  }

  private async submitInput(): Promise<void> {
    const raw = this.input;
    const promptInput = raw.trim();
    this.input = "";
    this.historyIndex = undefined;
    this.writeLine("");

    if (!promptInput) {
      this.prompt();
      return;
    }

    this.history.push(promptInput);
    if (promptInput === "exit" || promptInput === "/exit" || promptInput === "quit" || promptInput === "/quit") {
      this.writeLine("Closing Alpha terminal.");
      this.cancellation?.cancel();
      this.closeEmitter.fire();
      return;
    }
    if (promptInput === "/clear" || promptInput === "clear") {
      this.write("\x1b[2J\x1b[3J\x1b[H");
      this.prompt();
      return;
    }
    if (promptInput === "/history") {
      this.renderHistory();
      this.prompt();
      return;
    }
    if (await this.handleSessionCommand(promptInput)) {
      this.prompt();
      return;
    }

    this.busy = true;
    this.cancellation = new vscode.CancellationTokenSource();
    const stream = new TerminalResponseStream((text) => this.writeMarkdown(text));
    const session = this.currentSession();
    try {
      await handleAlphaTerminalRequest(this.extensionContext, session, promptInput, this.model, stream.asChatResponseStream(), this.cancellation.token);
      rememberTerminalTurn(session, promptInput, stream.markdownText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeMarkdown(`Alpha terminal error: ${message}`);
    } finally {
      this.cancellation.dispose();
      this.cancellation = undefined;
      this.busy = false;
      this.writeLine("");
      this.prompt();
    }
  }

  private cancelCurrentRequest(): void {
    if (!this.busy) {
      this.input = "";
      this.writeLine("^C");
      this.prompt();
      return;
    }
    this.writeLine("^C");
    this.cancellation?.cancel();
  }

  private previousHistory(): string {
    if (!this.history.length) return this.input;
    this.historyIndex = this.historyIndex === undefined
      ? this.history.length - 1
      : Math.max(0, this.historyIndex - 1);
    return this.history[this.historyIndex] ?? "";
  }

  private nextHistory(): string {
    if (this.historyIndex === undefined) return this.input;
    this.historyIndex += 1;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = undefined;
      return "";
    }
    return this.history[this.historyIndex] ?? "";
  }

  private replaceInput(next: string): void {
    this.write(`\r\x1b[2Kalpha> ${next}`);
    this.input = next;
  }

  private backspace(): void {
    if (!this.input.length) return;
    this.input = this.input.slice(0, -1);
    this.write("\b \b");
  }

  private renderHistory(): void {
    const session = this.currentSession();
    const transcript = buildTerminalTranscript(session);
    if (!transcript.length) {
      this.writeLine("No Alpha terminal history yet.");
      return;
    }
    for (const entry of transcript) {
      if (entry.role === "user") this.writeLine(`user: ${entry.content}`);
      if (entry.role === "assistant") this.writeLine(`alpha: ${entry.content.slice(0, 500)}${entry.content.length > 500 ? "..." : ""}`);
    }
  }

  private async handleSessionCommand(input: string): Promise<boolean> {
    const match = /^\/(new|sessions|session|resume|rename|clear-session)\b(?:\s+([\s\S]*))?$/i.exec(input);
    if (!match) return false;

    const command = match[1].toLowerCase();
    const arg = (match[2] ?? "").trim();

    if (command === "new") {
      const session = sessions.createTerminal(arg || undefined);
      this.switchSession(session);
      this.writeLine(`Started Alpha terminal session: ${session.label}`);
      return true;
    }

    if (command === "sessions" || command === "session") {
      this.renderSessions();
      return true;
    }

    if (command === "resume") {
      const session = arg ? this.resolveSessionArgument(arg) : await this.pickSession();
      if (!session) {
        this.writeLine("No Alpha terminal session selected.");
        return true;
      }
      this.switchSession(session);
      this.writeLine(`Resumed Alpha terminal session: ${session.label}`);
      return true;
    }

    if (command === "rename") {
      const nextLabel = arg || await vscode.window.showInputBox({
        title: "Rename Alpha Terminal Session",
        prompt: "Session name",
        value: this.currentSession().label,
        ignoreFocusOut: true,
      });
      if (!nextLabel?.trim()) {
        this.writeLine("Session rename cancelled.");
        return true;
      }
      const renamed = sessions.renameTerminal(this.currentSession().key, nextLabel);
      if (renamed) {
        this.switchSession(renamed);
        this.writeLine(`Renamed Alpha terminal session: ${renamed.label}`);
      }
      return true;
    }

    if (command === "clear-session") {
      const cleared = sessions.clearTerminal(this.currentSession().key);
      if (cleared) {
        this.switchSession(cleared);
        this.writeLine(`Cleared Alpha terminal session: ${cleared.label}`);
      }
      return true;
    }

    return false;
  }

  private currentSession(): AlphaSessionState {
    const session = sessions.getTerminal(this.sessionKey);
    this.sessionKey = session.key;
    return session;
  }

  private switchSession(session: AlphaSessionState): void {
    this.sessionKey = session.key;
  }

  private renderSessions(): void {
    const terminalSessions = sessions.terminalSessions();
    if (!terminalSessions.length) {
      this.writeLine("No Alpha terminal sessions.");
      return;
    }
    const activeKey = this.currentSession().key;
    this.writeLine("Alpha terminal sessions:");
    terminalSessions.forEach((session, index) => {
      const marker = session.key === activeKey ? "*" : " ";
      const turns = Math.ceil((session.terminalTranscript?.length ?? 0) / 2);
      this.writeLine(`${marker} ${index + 1}. ${session.label} (${turns} turn${turns === 1 ? "" : "s"}, ${formatTerminalDate(session.updatedAt)})`);
    });
    this.writeLine("Use `/resume <number>` to switch sessions, or `/new <name>` to start another.");
  }

  private resolveSessionArgument(arg: string): AlphaSessionState | undefined {
    const ordinal = Number(arg);
    if (Number.isInteger(ordinal)) return sessions.getTerminalByOrdinal(ordinal);

    const lower = arg.toLowerCase();
    return sessions.terminalSessions().find((session) => session.label.toLowerCase().includes(lower));
  }

  private async pickSession(): Promise<AlphaSessionState | undefined> {
    const terminalSessions = sessions.terminalSessions();
    if (!terminalSessions.length) return undefined;
    const picked = await vscode.window.showQuickPick(
      terminalSessions.map((session, index) => ({
        label: `${index + 1}. ${session.label}`,
        description: formatTerminalDate(session.updatedAt),
        detail: `${Math.ceil((session.terminalTranscript?.length ?? 0) / 2)} turn(s)`,
        session,
      })),
      { title: "Resume Alpha Terminal Session", placeHolder: "Choose a session", ignoreFocusOut: true },
    );
    return picked?.session;
  }

  private prompt(): void {
    this.write("alpha> ");
  }

  private writeMarkdown(text: string): void {
    this.write(normalizeTerminalText(text));
  }

  private writeLine(text: string): void {
    this.write(`${text}\r\n`);
  }

  private write(text: string): void {
    this.writeEmitter.fire(text);
  }
}

class TerminalResponseStream {
  private readonly chunks: string[] = [];

  constructor(private readonly write: (text: string) => void) {}

  get markdownText(): string {
    return this.chunks.join("").trim();
  }

  markdown(value: string | vscode.MarkdownString): void {
    const text = typeof value === "string" ? value : value.value;
    this.chunks.push(text);
    this.write(text);
  }

  progress(value: string): void {
    this.markdown(`_${value}_\n\n`);
  }

  asChatResponseStream(): vscode.ChatResponseStream {
    return this as unknown as vscode.ChatResponseStream;
  }
}

async function selectAlphaTerminalModel(): Promise<vscode.LanguageModelChat | undefined> {
  let models: vscode.LanguageModelChat[];
  try {
    models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Alpha could not access Copilot models: ${message}`);
    return undefined;
  }

  if (!models.length) {
    void vscode.window.showErrorMessage("Alpha did not find any Copilot chat models. Check Copilot sign-in, policy, and Language Model API access.");
    return undefined;
  }

  const preferred = models.find((model) => /gpt-4\.1|gpt-4o|claude.*sonnet/i.test(`${model.family} ${model.name}`));
  return preferred ?? models[0];
}

async function handleAlphaTerminalRequest(
  extensionContext: vscode.ExtensionContext,
  session: AlphaSessionState,
  input: string,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const transcript = buildTerminalTranscript(session);
  const request = terminalChatRequest(input, model);
  const chatContext = terminalChatContext(transcript);
  await handleAlphaParsedRequest(
    extensionContext,
    parseAlphaChatInput(input),
    session,
    request,
    chatContext,
    transcript,
    stream,
    token,
  );
}

function terminalChatRequest(input: string, model: vscode.LanguageModelChat): vscode.ChatRequest {
  const parsed = parseAlphaChatInput(input);
  return {
    prompt: parsed.prompt,
    command: parsed.command,
    model,
    references: [],
    toolReferences: [],
  } as unknown as vscode.ChatRequest;
}

function terminalChatContext(transcript: readonly AlphaTranscriptEntry[]): vscode.ChatContext {
  const historyLength = transcript.filter((entry) => entry.historyIndex !== undefined).length;
  return {
    history: new Array(historyLength),
  } as unknown as vscode.ChatContext;
}

function buildTerminalTranscript(session: AlphaSessionState): AlphaTranscriptEntry[] {
  const entries: AlphaTranscriptEntry[] = [];
  const compactionSummary = session.compactionSummary?.trim();
  if (compactionSummary) {
    entries.push({
      role: "compaction",
      content: compactionSummary,
      source: "compaction",
    });
  }
  for (const entry of session.terminalTranscript ?? []) {
    if (session.compactedThroughHistoryIndex !== undefined && (entry.historyIndex ?? -1) <= session.compactedThroughHistoryIndex) continue;
    entries.push(entry);
  }
  return entries;
}

function rememberTerminalTurn(session: AlphaSessionState, prompt: string, response: string): void {
  const transcript = session.terminalTranscript ?? [];
  const nextHistoryIndex = transcript.reduce((max, entry) => Math.max(max, entry.historyIndex ?? -1), -1) + 1;
  transcript.push({
    role: "user",
    content: prompt,
    source: "chat-history",
    historyIndex: nextHistoryIndex,
    participant: "alpha.terminal",
  });
  if (response.trim()) {
    transcript.push({
      role: "assistant",
      content: response.trim(),
      source: "chat-history",
      historyIndex: nextHistoryIndex + 1,
    });
  }
  session.terminalTranscript = transcript.slice(-200);
  sessions.persistNow();
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

function formatTerminalDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

async function handleAlphaRequest(
  extensionContext: vscode.ExtensionContext,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const parsedRequest = parseAlphaChatRequest(request);
  const session = sessions.get(chatContext, request);
  const transcript = buildAlphaTranscript(chatContext.history, {
    compactionSummary: session.compactionSummary,
    compactedThroughHistoryIndex: session.compactedThroughHistoryIndex,
  });
  await handleAlphaParsedRequest(extensionContext, parsedRequest, session, request, chatContext, transcript, stream, token);
}

async function handleAlphaParsedRequest(
  extensionContext: vscode.ExtensionContext,
  parsedRequest: ParsedAlphaChatRequest,
  session: AlphaSessionState,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  transcript: AlphaTranscriptEntry[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const alphaContext: AlphaContext = {
    extensionContext,
    sessionKey: session.key,
    sessionLabel: session.label,
    compactionSummary: session.compactionSummary,
    compactedThroughHistoryIndex: session.compactedThroughHistoryIndex,
    request,
    chatContext,
    transcript,
    stream,
    token,
    pendingEdits: session.pendingEdits,
    todos: session.todos,
    snapshots: session.snapshots,
    artifacts: session.artifacts,
    bashJobs: session.bashJobs,
    conflicts: session.conflicts,
    permissionDecisions: session.permissionDecisions,
    discoveredTools: session.discoveredTools,
    planMode: session.planMode,
    blueprintMode: session.blueprintMode,
    goalMode: session.goalMode,
    persistSession: () => sessions.persistNow(),
    setCompaction: (summary, compactedThroughHistoryIndex) => {
      session.compactionSummary = summary;
      session.compactedThroughHistoryIndex = compactedThroughHistoryIndex;
      alphaContext.compactionSummary = summary;
      alphaContext.compactedThroughHistoryIndex = compactedThroughHistoryIndex;
      sessions.persistNow();
    },
    setGoalMode: (state) => {
      session.goalMode = state;
      alphaContext.goalMode = state;
      sessions.persistNow();
    },
  };

  try {
    if (!parsedRequest.command && (!parsedRequest.prompt || parsedRequest.prompt === "help")) {
      stream.markdown("Alpha is an OMP-style VS Code chat participant. Invoke it with `@a` and ask naturally, e.g. `read src/foo.ts and explain it` or `search for TODO comments`.");
      return;
    }

    if (parsedRequest.command === "commit") {
      await runAlphaCommit(parsedRequest.prompt, alphaContext);
      return;
    }

    if (parsedRequest.command === "context") {
      const usage = await alphaContextUsageForPrompt(parsedRequest.prompt || "context usage", alphaContext);
      stream.markdown([
        `Alpha context usage: ${formatContextUsage(usage)}`,
        "",
        `Model: ${request.model.name}`,
        `Max input tokens: ${usage.maxInputTokens.toLocaleString()}`,
        `Compacted through history index: ${session.compactedThroughHistoryIndex ?? "none"}`,
        session.compactionSummary ? "Compaction summary: present" : "Compaction summary: none",
      ].join("\n"));
      return;
    }

    if (parsedRequest.command === "goal") {
      await handleGoalCommand(parsedRequest.prompt, session, alphaContext);
      return;
    }

    if (parsedRequest.command === "compact") {
      await compactAlphaSession(parsedRequest.prompt, session, alphaContext);
      return;
    }

    if (parsedRequest.command === "blueprint") {
      await handleBlueprintCommand(parsedRequest.prompt, session, alphaContext);
      return;
    }

    if (parsedRequest.command === "blueprint-generate") {
      await generatePlanFromBlueprint(parsedRequest.prompt, session, alphaContext);
      return;
    }

    if (parsedRequest.command === "plan") {
      if (session.goalMode?.enabled) {
        stream.markdown("Exit or complete the active Alpha goal before entering plan mode.");
        return;
      }
      if (session.blueprintMode?.active) {
        stream.markdown("Generate or discard the active Alpha blueprint before entering plan mode.");
        return;
      }
      await handlePlanCommand(parsedRequest.prompt, session, alphaContext);
      return;
    }

    if (parsedRequest.command === "plan-review") {
      await handlePlanReviewCommand(parsedRequest.prompt, session, alphaContext);
      return;
    }

    if (!parsedRequest.command && session.blueprintMode?.active) {
      if (isBlueprintGeneratePrompt(parsedRequest.prompt)) {
        await generatePlanFromBlueprint(parsedRequest.prompt, session, alphaContext);
      } else {
        await continueBlueprint(parsedRequest.prompt, session, alphaContext);
      }
      return;
    }

    if (!parsedRequest.command && session.planMode && (session.planMode.pendingApproval || session.planMode.approvedPlan)) {
      const handled = await handlePlanDecisionPrompt(parsedRequest.prompt, session, alphaContext);
      if (handled) return;
    }

    const expandedPrompt = await expandAlphaCommand(parsedRequest);
    if (expandedPrompt === undefined) return;
    await answerWithAlphaTools(expandedPrompt, alphaContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stream.markdown(`Alpha error: ${message}`);
  }
}

async function handleGoalCommand(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  if (session.planMode?.active) {
    ctx.stream.markdown("Exit Alpha plan mode before starting or changing a goal.");
    return;
  }

  const parsed = parseGoalCommand(prompt);
  if (parsed.op === "get") {
    ctx.stream.markdown(renderGoalStatus(session.goalMode));
    return;
  }

  if (parsed.op === "create") {
    const next = createGoal(session.goalMode, parsed.objective ?? "", parsed.tokenBudget);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(renderGoalToolResponse(goalToolResponse("create", next.goal)));
    return;
  }

  if (parsed.op === "replace") {
    const next = replaceGoal(session.goalMode, parsed.objective ?? "", parsed.tokenBudget);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(renderGoalToolResponse(goalToolResponse("create", next.goal)));
    return;
  }

  if (parsed.op === "resume") {
    const next = resumeGoal(session.goalMode);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(renderGoalToolResponse(goalToolResponse("resume", next.goal)));
    return;
  }

  if (parsed.op === "pause") {
    const next = pauseGoal(session.goalMode);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(next ? renderGoalToolResponse(goalToolResponse("get", next.goal)) : "No active goal.");
    return;
  }

  if (parsed.op === "budget") {
    const next = updateGoalBudget(session.goalMode, parsed.tokenBudget);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(renderGoalToolResponse(goalToolResponse("get", next.goal)));
    return;
  }

  if (parsed.op === "complete") {
    const next = completeGoal(session.goalMode);
    ctx.setGoalMode?.(next);
    ctx.stream.markdown(renderGoalToolResponse(goalToolResponse("complete", next.goal, true)));
    return;
  }

  if (parsed.op === "drop") {
    const dropped = dropGoal(session.goalMode);
    ctx.setGoalMode?.(undefined);
    ctx.stream.markdown(dropped ? renderGoalToolResponse(goalToolResponse("drop", dropped)) : "No active goal.");
  }
}

async function handleBlueprintCommand(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  const trimmed = prompt.trim();
  if (session.planMode?.active || session.planMode?.pendingApproval) {
    ctx.stream.markdown("Exit or finish Alpha plan mode before starting a blueprint.");
    return;
  }
  if (session.goalMode?.enabled) {
    ctx.stream.markdown("Exit or complete the active Alpha goal before starting a blueprint.");
    return;
  }

  if (isBlueprintDiscardPrompt(trimmed)) {
    session.blueprintMode = undefined;
    ctx.blueprintMode = undefined;
    sessions.persistNow();
    ctx.stream.markdown("Discarded Alpha blueprint.");
    return;
  }

  if (trimmed === "status" || trimmed === "review" || trimmed === "show") {
    ctx.stream.markdown(renderBlueprintStatus(session.blueprintMode));
    return;
  }

  const template = parseBlueprintTemplate(trimmed);
  if (template && session.blueprintMode?.active && /^template\b/i.test(trimmed)) {
    const selection = parseBlueprintTemplateSelection(trimmed.replace(/^template\b\s*/i, "")) ?? { template };
    session.blueprintMode = setBlueprintTemplate(session.blueprintMode, selection.template, selection.customTemplatePrompt);
    ctx.blueprintMode = session.blueprintMode;
    sessions.persistNow();
    ctx.stream.markdown(renderBlueprintStatus(session.blueprintMode));
    return;
  }

  if (session.blueprintMode?.active) {
    await continueBlueprint(trimmed, session, ctx);
    return;
  }

  if (!trimmed) {
    ctx.stream.markdown("Start a blueprint with `@a /blueprint <request>`. Use `/blueprint-generate` when the Q&A is ready to become an Alpha plan.");
    return;
  }

  session.blueprintMode = createBlueprintModeState(trimmed);
  ctx.blueprintMode = session.blueprintMode;
  sessions.persistNow();
  ctx.stream.markdown(renderBlueprintTemplateQuestion(session.blueprintMode));
}

async function continueBlueprint(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  if (!session.blueprintMode?.active) {
    ctx.stream.markdown("No active Alpha blueprint. Start one with `@a /blueprint <request>`.");
    return;
  }
  if (!session.blueprintMode.templateSelected) {
    const selection = parseBlueprintTemplateSelection(prompt);
    if (!selection) {
      ctx.stream.markdown(renderBlueprintTemplateQuestion(session.blueprintMode, "I could not determine the template selection."));
      return;
    }
    if (selection.template === "custom" && !selection.customTemplatePrompt) {
      ctx.stream.markdown(renderBlueprintTemplateQuestion(session.blueprintMode, "For `Other`, include the custom plan structure or level of detail, for example `1c: Overview, Risks, Steps, Tests`."));
      return;
    }
    session.blueprintMode = setBlueprintTemplate(session.blueprintMode, selection.template, selection.customTemplatePrompt);
    ctx.blueprintMode = session.blueprintMode;
    sessions.persistNow();
    await answerWithAlphaTools(buildBlueprintStartPrompt(session.blueprintMode), ctx);
    return;
  }
  const template = parseBlueprintTemplate(prompt);
  if (template && /^template\b/i.test(prompt)) {
    const selection = parseBlueprintTemplateSelection(prompt.replace(/^template\b\s*/i, "")) ?? { template };
    session.blueprintMode = setBlueprintTemplate(session.blueprintMode, selection.template, selection.customTemplatePrompt);
  } else {
    session.blueprintMode = appendBlueprintAnswer(session.blueprintMode, prompt);
  }
  ctx.blueprintMode = session.blueprintMode;
  sessions.persistNow();
  await answerWithAlphaTools(buildBlueprintContinuePrompt(prompt, session.blueprintMode.refinedPrompt), ctx);
}

async function generatePlanFromBlueprint(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  const blueprint = session.blueprintMode;
  if (!blueprint?.active) {
    ctx.stream.markdown("No active Alpha blueprint to generate from.");
    return;
  }
  if (session.planMode?.active || session.planMode?.pendingApproval) {
    ctx.stream.markdown("A plan is already active or waiting for approval.");
    return;
  }
  if (!blueprint.templateSelected) {
    ctx.stream.markdown(renderBlueprintTemplateQuestion(blueprint, "Choose a template before generating the plan."));
    return;
  }

  const template = parseBlueprintTemplate(prompt);
  const nextBlueprint = deactivateBlueprintMode(template ? setBlueprintTemplate(blueprint, template) : blueprint);
  const refinedPrompt = await blueprintRefinedPromptForGeneration(nextBlueprint, ctx);
  nextBlueprint.refinedPrompt = refinedPrompt;
  session.blueprintMode = nextBlueprint;
  ctx.blueprintMode = nextBlueprint;
  session.planMode = createPlanModeState(refinedPrompt);
  ctx.planMode = session.planMode;
  sessions.persistNow();

  await answerWithAlphaTools(buildBlueprintGeneratePrompt(nextBlueprint), ctx);
}

async function blueprintRefinedPromptForGeneration(
  state: NonNullable<AlphaSessionState["blueprintMode"]>,
  ctx: AlphaContext,
): Promise<string> {
  try {
    const resource = await resolveInternalUrl(state.blueprintPath, ctx);
    const content = resource.content.trim();
    return content || state.refinedPrompt;
  } catch {
    return state.refinedPrompt;
  }
}

function buildBlueprintStartPrompt(state: NonNullable<AlphaSessionState["blueprintMode"]>): string {
  return [
    "Start Alpha Blueprint mode for this request.",
    `Selected template: ${state.template}${state.customTemplatePrompt ? ` (${state.customTemplatePrompt})` : ""}.`,
    "Investigate enough to ask useful questions. Use read-only explore subagents with task fanout when the work is broad.",
    "Ask the first 3-5 clarifying questions. Do not skip the question round on your own.",
    "Questions must match the selected template's level and perspective. For concise templates, avoid deep implementation-detail questions unless necessary.",
    "Users generally expect to continue existing patterns and expand their system; only question existing patterns when the requested change clearly conflicts with them.",
    "Focus on decisions that meaningfully affect implementation, not trivial or obvious choices.",
    "Use Blueprint-style inline questions with **Q1. ...**, brief context, lettered choices, and a final Other (describe) choice where options fit.",
    "Leave two blank lines between questions and a blank line between the question text, context line, and options.",
    "Include the shorthand-answer hint before the questions. Do not generate the plan yet.",
    "When you ask questions, also write the current refined prompt to local://alpha-blueprint.md in Blueprint format: original request exactly, then `*` clarification bullets inserted in logical locations near related content.",
    "",
    state.refinedPrompt,
  ].join("\n");
}

function buildBlueprintContinuePrompt(userAnswer: string, refinedPrompt: string): string {
  return [
    "Continue Alpha Blueprint mode with this user answer or refinement.",
    "Acknowledge briefly, show the updated refined prompt in a blockquote, then ask 3-5 more questions.",
    "Do not repeat questions whose answers are already captured in the refined prompt or prior chat. Do not ask about choices already settled by this answer.",
    "The next questions may be follow-ups to the user's answers or additional new/ambiguous topics that still need to be discussed.",
    "Keep asking question rounds until the user runs `/blueprint-generate`. Do not stop asking questions on your own.",
    "Questions must match the selected template's level and perspective. For concise templates, avoid deep implementation-detail questions unless necessary.",
    "Users generally expect to continue existing patterns and expand their system; only question existing patterns when the requested change clearly conflicts with them.",
    "Focus on decisions that meaningfully affect implementation, not trivial or obvious choices.",
    "Use Blueprint-style inline questions with **Q1. ...**, brief context, lettered choices, and a final Other (describe) choice where options fit.",
    "Leave two blank lines between questions and a blank line between the question text, context line, and options.",
    "Update local://alpha-blueprint.md with the current refined prompt in Blueprint format: original request exactly, then `*` clarification bullets inserted in logical locations near related content.",
    "After the questions, remind the user to run `/blueprint-generate` when ready to end Q&A and generate the plan.",
    "Do not generate the plan yet.",
    "",
    "Current stored refined prompt:",
    refinedPrompt,
    "",
    userAnswer,
  ].join("\n");
}

function isBlueprintDiscardPrompt(prompt: string): boolean {
  return /\b(discard|cancel|abandon|drop|clear)\b/i.test(prompt);
}

async function compactAlphaSession(
  note: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  const compactable = compactableTranscriptEntries(ctx.transcript);
  const lastHistoryIndex = compactable.at(-1)?.historyIndex;
  if (lastHistoryIndex === undefined) {
    ctx.stream.markdown("No Alpha chat history is available to compact.");
    return;
  }
  const usage = await alphaContextUsageForPrompt(note || "compact current Alpha session", ctx);
  const result = await compactTranscriptWithModel({
    model: ctx.request.model,
    token: ctx.token,
    sessionLabel: ctx.sessionLabel,
    sessionKey: ctx.sessionKey,
    transcript: compactable,
    existingSummary: ctx.compactionSummary,
    throughHistoryIndex: lastHistoryIndex,
    tokensBefore: usage.inputTokens,
  });
  session.compactionSummary = result.summary;
  session.compactedThroughHistoryIndex = result.compactedThroughHistoryIndex;
  ctx.compactionSummary = result.summary;
  ctx.compactedThroughHistoryIndex = result.compactedThroughHistoryIndex;
  sessions.persistNow();
  ctx.stream.markdown([
    "Alpha compaction complete.",
    "",
    `Compacted through history index: ${result.compactedThroughHistoryIndex}`,
    `Tokens before: ${result.tokensBefore.toLocaleString()}`,
    "",
    result.summary,
  ].join("\n"));
}

async function handlePlanReviewCommand(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  const state = session.planMode;
  if (!state) {
    ctx.stream.markdown("No Alpha plan is available in this chat session.");
    return;
  }

  const planPath = state.approvedPlanPath ?? state.planPath;
  let plan = state.approvedPlan;
  if (!plan) {
    try {
      plan = (await resolveInternalUrl(planPath, ctx)).content;
    } catch {
      ctx.stream.markdown("No plan to review yet. Ask Alpha to write one to `local://alpha-plan.md` first.");
      return;
    }
  }

  const contextUsage = await alphaContextUsageForPrompt("plan review", ctx);
  if (isPlanOpenQuestionsPrompt(prompt)) {
    await answerWithAlphaTools(buildPlanOpenQuestionsPrompt(plan, planPath), ctx);
    return;
  }

  if (!state.active && state.approvedPlan && !state.pendingApproval) {
    ctx.stream.markdown([
      renderPlanReview(state),
      "",
      `Current context: ${formatContextUsage(contextUsage)}`,
      "",
      "This plan is not waiting for approval. Type `approve and implement as goal` to retry it with goal tracking, `approve and implement` to retry once, `refine: <what to change>` to revise it, or `discard plan` to clear it.",
    ].join("\n"));
    return;
  }

  state.approvedPlan = plan;
  state.approvedPlanPath = planPath;
  state.planPath = planPath;
  state.pendingApproval = true;
  state.updatedAt = new Date().toISOString();
  ctx.planMode = state;
  sessions.persistNow();
  ctx.stream.markdown(`${renderPlanReview(state)}\n\nCurrent context: ${formatContextUsage(contextUsage)}\n\nType one of:\n- \`approve and implement as goal\`\n- \`approve and implement\`\n- \`refine: <what to change>\`\n- \`discard plan\``);
}

async function handlePlanDecisionPrompt(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<boolean> {
  const state = session.planMode;
  if (!state || (!state.pendingApproval && !state.approvedPlan)) return false;

  if (isPlanDiscardPrompt(prompt)) {
    session.planMode = undefined;
    ctx.planMode = undefined;
    sessions.persistNow();
    ctx.stream.markdown("Discarded Alpha plan.");
    return true;
  }

  if (isPlanRefinePrompt(prompt)) {
    state.active = true;
    state.pendingApproval = false;
    state.updatedAt = new Date().toISOString();
    ctx.planMode = state;
    sessions.persistNow();

    const refinement = prompt.replace(/^\s*(refine|revise|change|update|modify)(\s+plan)?\s*[:,-]?\s*/i, "").trim();
    if (!refinement) {
      ctx.stream.markdown(`${renderPlanReview(state)}\n\nTell me what to change in the plan.`);
      return true;
    }

    ctx.stream.markdown(`${renderPlanReview(state)}\n\nRefining the plan from your instructions.\n\n`);
    await answerWithAlphaTools(`Refine the pending Alpha plan with this user instruction: ${refinement}`, ctx);
    return true;
  }

  if (isPlanOpenQuestionsPrompt(prompt)) {
    const planPath = state.approvedPlanPath ?? state.planPath;
    let plan = state.approvedPlan;
    if (!plan) {
      try {
        plan = (await resolveInternalUrl(planPath, ctx)).content;
      } catch {
        ctx.stream.markdown("No plan to review yet. Ask Alpha to write one to `local://alpha-plan.md` first.");
        return true;
      }
    }
    await answerWithAlphaTools(buildPlanOpenQuestionsPrompt(plan, planPath), ctx);
    return true;
  }

  if (isPlanApprovalPrompt(prompt)) {
    await approvePlanAndExecute(prompt, session, ctx);
    return true;
  }

  return false;
}

async function approvePlanAndExecute(
  userApprovalMessage: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  const state = session.planMode;
  if (!state) {
    ctx.stream.markdown("No active Alpha plan is waiting for approval.");
    return;
  }
  if (!state.active && !state.approvedPlan) {
    ctx.stream.markdown("No active or approved Alpha plan is waiting for implementation.");
    return;
  }

  const approvedPlanPath = state.approvedPlanPath ?? state.planPath;
  const approvedPlan = state.approvedPlan ?? (await resolveInternalUrl(approvedPlanPath, ctx)).content;
  const executeAsGoal = isPlanApprovalAsGoalPrompt(userApprovalMessage);
  state.approvedPlan = approvedPlan;
  state.approvedPlanPath = approvedPlanPath;
  state.active = false;
  state.pendingApproval = false;
  state.updatedAt = new Date().toISOString();
  ctx.planMode = state;
  if (executeAsGoal) {
    if (session.goalMode?.goal && session.goalMode.goal.status !== "complete" && session.goalMode.goal.status !== "dropped") {
      ctx.stream.markdown("An Alpha goal is already active. Complete, pause, or drop it before approving this plan as a new goal.");
      sessions.persistNow();
      return;
    }
    const goalState = createGoal(
      session.goalMode,
      buildPlanGoalObjective(approvedPlan, approvedPlanPath, userApprovalMessage),
    );
    ctx.setGoalMode?.(goalState);
  }
  sessions.persistNow();

  const executionPrompt = [
    executeAsGoal
      ? "The user explicitly approved the pending Alpha plan as an active Alpha goal. Implement the approved plan now while preserving the goal until verified complete."
      : "The user explicitly approved the pending Alpha plan. Implement it now.",
    `\nApproved plan:\n${approvedPlan}`,
    userApprovalMessage ? `\nUser approval message:\n${userApprovalMessage}` : "",
  ].join("\n");
  await answerWithAlphaTools(executionPrompt, ctx);
}

function isPlanApprovalPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/\b(cancel|discard|abandon|revise|refine|change|update|modify|not yet|don't|do not)\b/.test(text)) return false;
  return /\b(approve|approved|apply|implement|execute|proceed|go ahead|start)\b/.test(text);
}

function isPlanRefinePrompt(prompt: string): boolean {
  return /\b(refine|revise|change|update|modify)\b/i.test(prompt);
}

function isPlanDiscardPrompt(prompt: string): boolean {
  return /\b(discard|cancel|abandon|drop)\b/i.test(prompt);
}

async function handlePlanCommand(
  prompt: string,
  session: AlphaSessionState,
  ctx: AlphaContext,
): Promise<void> {
  if (session.planMode?.active) {
    if (!prompt) {
      session.planMode = undefined;
      ctx.planMode = undefined;
      sessions.persistNow();
      ctx.stream.markdown("Exited Alpha plan mode without applying a plan.");
      return;
    }

    ctx.stream.markdown(`${renderPlanModeStatus(session.planMode)}\n\n`);
    await answerWithAlphaTools(prompt, ctx);
    return;
  }

  session.planMode = createPlanModeState(prompt || undefined);
  ctx.planMode = session.planMode;
  sessions.persistNow();

  if (!prompt) {
    ctx.stream.markdown(`${renderPlanModeStatus(session.planMode)}\n\nSend \`@a /plan <goal>\` to start planning, or ask naturally in this chat while plan mode is active.`);
    return;
  }

  await answerWithAlphaTools(prompt, ctx);
}

interface ParsedAlphaChatRequest {
  command?: string;
  prompt: string;
}

function parseAlphaChatRequest(request: vscode.ChatRequest): ParsedAlphaChatRequest {
  return parseAlphaPrompt(request.prompt, request.command);
}

function parseAlphaChatInput(input: string): ParsedAlphaChatRequest {
  return parseAlphaPrompt(input);
}

function parseAlphaPrompt(input: string, explicitCommand?: string): ParsedAlphaChatRequest {
  const prompt = input.trim();
  const command = explicitCommand?.trim();
  if (command) return { command, prompt };

  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!match) return { prompt };

  return {
    command: match[1],
    prompt: (match[2] ?? "").trim(),
  };
}

async function expandAlphaCommand(request: ParsedAlphaChatRequest): Promise<string | undefined> {
  if (!request.command) return request.prompt;
  if (request.command !== "review") return `/${request.command}${request.prompt ? ` ${request.prompt}` : ""}`;
  const expanded = await buildInteractiveReviewPrompt(request.prompt, workspaceRoot().fsPath);
  if (!expanded) return undefined;
  return expanded;
}
