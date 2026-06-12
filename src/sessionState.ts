import { createHash } from "node:crypto";
import * as vscode from "vscode";
import {
  InMemoryArtifactStore,
  InMemoryBashJobStore,
  InMemoryFileSnapshotStore,
  InMemoryPendingEditStore,
  InMemoryTodoStore,
} from "./store";
import type { ArtifactStore, BashJobStore, FileSnapshotStore, PendingEditStore, TodoStore } from "./types";
import { workspaceFolders } from "./workspace";

export interface AlphaSessionState {
  key: string;
  label: string;
  pendingEdits: PendingEditStore;
  todos: TodoStore;
  snapshots: FileSnapshotStore;
  artifacts: ArtifactStore;
  bashJobs: BashJobStore;
}

export class AlphaSessionManager {
  private readonly byKey = new Map<string, AlphaSessionState>();
  private readonly byContext = new WeakMap<vscode.ChatContext, AlphaSessionState>();
  private latestKey: string | undefined;

  get(chatContext: vscode.ChatContext, request: vscode.ChatRequest): AlphaSessionState {
    const contextState = this.byContext.get(chatContext);
    if (contextState) {
      this.latestKey = contextState.key;
      return contextState;
    }

    const key = sessionKey(chatContext, request);
    let state = this.byKey.get(key);
    if (!state) {
      state = createSessionState(key, sessionLabel(chatContext, request));
      this.byKey.set(key, state);
    }
    this.byContext.set(chatContext, state);
    this.latestKey = state.key;
    return state;
  }

  latest(): AlphaSessionState | undefined {
    return this.latestKey ? this.byKey.get(this.latestKey) : undefined;
  }

  list(): AlphaSessionState[] {
    return [...this.byKey.values()];
  }

  clear(): void {
    for (const state of this.byKey.values()) {
      state.pendingEdits.clear();
      state.snapshots.clear();
      state.artifacts.clear();
      state.bashJobs.clear();
    }
    this.byKey.clear();
    this.latestKey = undefined;
  }
}

function createSessionState(key: string, label: string): AlphaSessionState {
  return {
    key,
    label,
    pendingEdits: new InMemoryPendingEditStore(),
    todos: new InMemoryTodoStore(),
    snapshots: new InMemoryFileSnapshotStore(),
    artifacts: new InMemoryArtifactStore(),
    bashJobs: new InMemoryBashJobStore(),
  };
}

function sessionKey(chatContext: vscode.ChatContext, request: vscode.ChatRequest): string {
  const first = firstRequestTurn(chatContext) ?? request;
  const workspaceKey = workspaceFolders().map((folder) => folder.uri.toString()).sort().join("|") || "no-workspace";
  const command = first.command ?? "";
  const prompt = first.prompt.trim();
  const participant = isChatRequestTurn(first) ? first.participant : "alpha.participant";
  const digest = createHash("sha256").update(`${workspaceKey}\0${participant}\0${command}\0${prompt}`).digest("hex").slice(0, 16);
  return `${workspaceKey}#${digest}`;
}

function sessionLabel(chatContext: vscode.ChatContext, request: vscode.ChatRequest): string {
  const first = firstRequestTurn(chatContext) ?? request;
  const prompt = first.prompt.trim().replace(/\s+/g, " ");
  return prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt || "Alpha chat";
}

function firstRequestTurn(chatContext: vscode.ChatContext): vscode.ChatRequestTurn | undefined {
  return chatContext.history.find(isChatRequestTurn);
}

function isChatRequestTurn(turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn | vscode.ChatRequest): turn is vscode.ChatRequestTurn {
  return "prompt" in turn && "participant" in turn;
}
