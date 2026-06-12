import * as vscode from "vscode";
import { applyWorkspaceEdits } from "./patch/hashline";
import { InMemoryPendingEditStore, InMemoryTodoStore } from "./store";
import type { AlphaContext } from "./types";
import { toolHelp, tools } from "./tools";

const pendingEdits = new InMemoryPendingEditStore();
const todos = new InMemoryTodoStore();

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
  };

  try {
    if (!prompt || prompt === "help" || prompt === "/help") {
      stream.markdown(["Alpha tools:", "", toolHelp(), "", "Use `/read path`, `/search text`, `/edit` with hashline edits, or ask normally."].join("\n"));
      return;
    }

    const explicit = parseExplicitToolCall(prompt);
    if (explicit) {
      const tool = tools.find((candidate) => candidate.name === explicit.name);
      if (!tool) {
        stream.markdown(`Unknown Alpha tool \`${explicit.name}\`.\n\n${toolHelp()}`);
        return;
      }
      const result = await tool.run(explicit.args, alphaContext);
      stream.markdown(result.markdown);
      return;
    }

    await answerWithModel(prompt, alphaContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stream.markdown(`Alpha error: ${message}`);
  }
}

function parseExplicitToolCall(prompt: string): { name: string; args: string } | undefined {
  const match = prompt.match(/^\/?([a-z_][a-z0-9_]*)\b\s*([\s\S]*)$/i);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  if (!tools.some((tool) => tool.name === name)) return undefined;
  return { name, args: match[2] ?? "" };
}

async function answerWithModel(prompt: string, ctx: AlphaContext): Promise<void> {
  const messages = [
    vscode.LanguageModelChatMessage.User(
      [
        "You are Alpha, an OMP-style local coding harness inside VS Code.",
        "Available local tools are not invoked automatically in this prototype; tell the user which /tool command to run when workspace context is needed.",
        "Keep answers concise and implementation-focused.",
        "",
        "Tools:",
        toolHelp(),
      ].join("\n"),
    ),
    vscode.LanguageModelChatMessage.User(prompt),
  ];
  const response = await ctx.request.model.sendRequest(messages, {}, ctx.token);
  for await (const chunk of response.text) {
    ctx.stream.markdown(chunk);
  }
}
