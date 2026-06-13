import * as vscode from "vscode";
import { applyWorkspaceEdits } from "./patch/hashline";
import { AlphaSessionManager } from "./sessionState";
import { buildAlphaTranscript } from "./transcript";
import type { AlphaContext } from "./types";
import { answerWithAlphaTools } from "./lmTools";

let sessions: AlphaSessionManager;

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
  sessions.clear();
}

async function handleAlphaRequest(
  extensionContext: vscode.ExtensionContext,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const prompt = request.prompt.trim();
  const session = sessions.get(chatContext, request);
  const transcript = buildAlphaTranscript(chatContext.history, { compactionSummary: session.compactionSummary });
  const alphaContext: AlphaContext = {
    extensionContext,
    sessionKey: session.key,
    sessionLabel: session.label,
    compactionSummary: session.compactionSummary,
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
    permissionDecisions: session.permissionDecisions,
    discoveredTools: session.discoveredTools,
  };

  try {
    if (!prompt || prompt === "help") {
      stream.markdown("Alpha is an OMP-style VS Code chat participant. Invoke it with `@a` and ask naturally, e.g. `read src/foo.ts and explain it` or `search for TODO comments`.");
      return;
    }

    await answerWithAlphaTools(prompt, alphaContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stream.markdown(`Alpha error: ${message}`);
  }
}
