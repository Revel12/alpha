import * as vscode from "vscode";
import { applyWorkspaceEdits } from "./patch/hashline";
import { InMemoryFileSnapshotStore, InMemoryPendingEditStore, InMemoryTodoStore } from "./store";
import type { AlphaContext } from "./types";
import { answerWithAlphaTools } from "./lmTools";

const pendingEdits = new InMemoryPendingEditStore();
const todos = new InMemoryTodoStore();
const snapshots = new InMemoryFileSnapshotStore();

export function activate(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant("alpha.participant", async (request, chatContext, stream, token) => {
    await handleAlphaRequest(context, request, chatContext, stream, token);
  });
  participant.iconPath = new vscode.ThemeIcon("hubot");

  context.subscriptions.push(
    participant,
    vscode.commands.registerCommand("alpha.openPendingEdits", async () => {
      const edits = pendingEdits.list();
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
      const edits = pendingEdits.list();
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
        pendingEdits.remove(picked.edit.id);
        void vscode.window.showInformationMessage(`Applied ${picked.edit.id}.`);
      } else {
        void vscode.window.showErrorMessage(`VS Code rejected ${picked.edit.id}.`);
      }
    }),
    vscode.commands.registerCommand("alpha.clearPendingEdits", () => {
      pendingEdits.clear();
      void vscode.window.showInformationMessage("Cleared Alpha pending edits.");
    }),
  );
}

export function deactivate(): void {
  pendingEdits.clear();
  snapshots.clear();
}

async function handleAlphaRequest(
  extensionContext: vscode.ExtensionContext,
  request: vscode.ChatRequest,
  _chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const prompt = request.prompt.trim();
  const alphaContext: AlphaContext = {
    extensionContext,
    request,
    stream,
    token,
    pendingEdits,
    todos,
    snapshots,
  };

  try {
    if (!prompt || prompt === "help") {
      stream.markdown("Alpha is an OMP-style VS Code chat participant. Ask naturally, e.g. `read src/foo.ts and explain it` or `search for TODO comments`.");
      return;
    }

    await answerWithAlphaTools(prompt, alphaContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stream.markdown(`Alpha error: ${message}`);
  }
}
