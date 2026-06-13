import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  InMemoryArtifactStore,
  InMemoryBashJobStore,
  InMemoryDiscoveredToolStore,
  InMemoryFileSnapshotStore,
  InMemoryPendingEditStore,
  InMemoryPermissionDecisionStore,
  InMemoryTodoStore,
} from "./store";
import { buildAlphaTranscript, firstUserPromptFromTranscript } from "./transcript";
import type {
  Artifact,
  ArtifactStore,
  BashJob,
  BashJobStore,
  DiscoveredToolStore,
  FileSnapshot,
  FileSnapshotStore,
  PendingEdit,
  PendingEditStore,
  PermissionDecisionStore,
  TodoItem,
  TodoPhase,
  TodoStore,
  WorkspaceTextEdit,
} from "./types";
import { workspaceFolders } from "./workspace";

const STORAGE_KEY = "alpha.sessions.v1";
const MAX_PERSISTED_SESSIONS = 25;

export interface AlphaSessionState {
  key: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  compactionSummary?: string;
  pendingEdits: PendingEditStore;
  todos: TodoStore;
  snapshots: FileSnapshotStore;
  artifacts: ArtifactStore;
  bashJobs: BashJobStore;
  permissionDecisions: PermissionDecisionStore;
  discoveredTools: DiscoveredToolStore;
}

export class AlphaSessionManager {
  private readonly byKey = new Map<string, AlphaSessionState>();
  private readonly byContext = new WeakMap<vscode.ChatContext, AlphaSessionState>();
  private latestKey: string | undefined;

  constructor(private readonly extensionContext: vscode.ExtensionContext) {
    this.restore();
  }

  get(chatContext: vscode.ChatContext, request: vscode.ChatRequest): AlphaSessionState {
    const contextState = this.byContext.get(chatContext);
    if (contextState) {
      this.touch(contextState);
      this.latestKey = contextState.key;
      return contextState;
    }

    const key = sessionKey(chatContext, request);
    let state = this.byKey.get(key);
    if (!state) {
      state = createSessionState(key, sessionLabel(chatContext, request), () => this.persistSoon(), undefined, artifactDirForSession(this.extensionContext, key));
      this.byKey.set(key, state);
      this.persistSoon();
    }
    this.touch(state);
    this.byContext.set(chatContext, state);
    this.latestKey = state.key;
    return state;
  }

  latest(): AlphaSessionState | undefined {
    return this.latestKey ? this.byKey.get(this.latestKey) : undefined;
  }

  list(): AlphaSessionState[] {
    return [...this.byKey.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  clear(): void {
    for (const state of this.byKey.values()) {
      state.pendingEdits.clear();
      state.snapshots.clear();
      state.artifacts.clear();
      state.bashJobs.clear();
      state.permissionDecisions.clear();
      state.discoveredTools.clear();
    }
    this.byKey.clear();
    this.latestKey = undefined;
    void this.extensionContext.workspaceState.update(STORAGE_KEY, undefined);
  }

  persistNow(): void {
    void this.extensionContext.workspaceState.update(STORAGE_KEY, this.toPersisted());
  }

  private touch(state: AlphaSessionState): void {
    state.updatedAt = new Date().toISOString();
    this.persistSoon();
  }

  private persistSoon(): void {
    queueMicrotask(() => this.persistNow());
  }

  private restore(): void {
    const persisted = this.extensionContext.workspaceState.get<PersistedSessionRoot>(STORAGE_KEY);
    if (!persisted?.sessions?.length) return;
    for (const raw of prunePersistedSessions(persisted.sessions).slice(0, MAX_PERSISTED_SESSIONS)) {
      const state = createSessionState(raw.key, raw.label, () => this.persistSoon(), raw, artifactDirForSession(this.extensionContext, raw.key));
      this.byKey.set(state.key, state);
    }
    this.latestKey = persisted.latestKey && this.byKey.has(persisted.latestKey) ? persisted.latestKey : this.list()[0]?.key;
  }

  private toPersisted(): PersistedSessionRoot {
    const sessions = prunePersistedSessions(this.list().map(toPersistedSession)).slice(0, MAX_PERSISTED_SESSIONS);
    return {
      version: 1,
      latestKey: this.latestKey,
      sessions,
    };
  }
}

function createSessionState(
  key: string,
  label: string,
  onChange: () => void = () => undefined,
  persisted?: PersistedSession,
  artifactDir?: string,
): AlphaSessionState {
  let state: AlphaSessionState | undefined;
  const notifyChanged = () => {
    if (!state) return;
    state.updatedAt = new Date().toISOString();
    onChange();
  };
  state = {
    key,
    label,
    createdAt: persisted?.createdAt ?? new Date().toISOString(),
    updatedAt: persisted?.updatedAt ?? new Date().toISOString(),
    compactionSummary: persisted?.compactionSummary,
    pendingEdits: new InMemoryPendingEditStore((persisted?.pendingEdits ?? []).map(fromPersistedPendingEdit), notifyChanged),
    todos: new InMemoryTodoStore(persisted?.todos ?? [], notifyChanged),
    snapshots: new InMemoryFileSnapshotStore(persisted?.snapshots ?? [], notifyChanged),
    artifacts: new InMemoryArtifactStore((persisted?.artifacts ?? []).map(fromPersistedArtifact), notifyChanged, artifactDir),
    bashJobs: new InMemoryBashJobStore(persisted?.bashJobs ?? [], notifyChanged),
    permissionDecisions: new InMemoryPermissionDecisionStore(),
    discoveredTools: new InMemoryDiscoveredToolStore(persisted?.discoveredTools ?? [], notifyChanged),
  };
  return state;
}

function toPersistedSession(state: AlphaSessionState): PersistedSession {
  return {
    key: state.key,
    label: state.label,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    compactionSummary: state.compactionSummary,
    pendingEdits: state.pendingEdits.list().map(toPersistedPendingEdit),
    todos: state.todos.list(),
    snapshots: state.snapshots.list(),
    artifacts: state.artifacts.list().map(toPersistedArtifact),
    bashJobs: state.bashJobs.list().map(toPersistedBashJob),
    discoveredTools: state.discoveredTools.list(),
  };
}

function artifactDirForSession(extensionContext: vscode.ExtensionContext, key: string): string {
  const root = extensionContext.storageUri ?? extensionContext.globalStorageUri;
  return path.join(root.fsPath, "alpha-artifacts", sanitizePathSegment(key));
}

function sessionKey(chatContext: vscode.ChatContext, request: vscode.ChatRequest): string {
  const transcript = buildAlphaTranscript(chatContext.history);
  const firstPrompt = firstUserPromptFromTranscript(transcript) ?? request.prompt.trim();
  const first = firstRequestTurn(chatContext);
  const workspaceKey = workspaceFolders().map((folder) => folder.uri.toString()).sort().join("|") || "no-workspace";
  const command = first?.command ?? request.command ?? "";
  const participant = first?.participant ?? "alpha.participant";
  const digest = createHash("sha256").update(`${workspaceKey}\0${participant}\0${command}\0${firstPrompt}`).digest("hex").slice(0, 16);
  return `${workspaceKey}#${digest}`;
}

function sessionLabel(chatContext: vscode.ChatContext, request: vscode.ChatRequest): string {
  const transcript = buildAlphaTranscript(chatContext.history);
  const prompt = (firstUserPromptFromTranscript(transcript) ?? request.prompt.trim()).replace(/\s+/g, " ");
  return prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt || "Alpha chat";
}

function firstRequestTurn(chatContext: vscode.ChatContext): vscode.ChatRequestTurn | undefined {
  return chatContext.history.find(isChatRequestTurn);
}

function isChatRequestTurn(turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn | vscode.ChatRequest): turn is vscode.ChatRequestTurn {
  return "prompt" in turn && "participant" in turn;
}

function prunePersistedSessions(sessions: PersistedSession[]): PersistedSession[] {
  const retentionDays = vscode.workspace.getConfiguration("alpha").get<number>("session.retentionDays", 30);
  const cutoffMs = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  return sessions
    .filter((session) => {
      const touchedMs = Date.parse(session.updatedAt);
      return Number.isFinite(touchedMs) && touchedMs >= cutoffMs;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

interface PersistedSessionRoot {
  version: 1;
  latestKey?: string;
  sessions: PersistedSession[];
}

interface PersistedSession {
  key: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  compactionSummary?: string;
  pendingEdits?: PersistedPendingEdit[];
  todos?: TodoPhase[] | TodoItem[];
  snapshots?: FileSnapshot[];
  artifacts?: PersistedArtifact[];
  bashJobs?: BashJob[];
  discoveredTools?: string[];
}

interface PersistedArtifact {
  id: string;
  label: string;
  createdAt: string;
  filePath?: string;
  content?: string;
}

interface PersistedPendingEdit {
  id: string;
  label: string;
  createdAt: string;
  edits: PersistedWorkspaceTextEdit[];
  expectedTags?: Record<string, string>;
}

interface PersistedWorkspaceTextEdit {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

function toPersistedPendingEdit(edit: PendingEdit): PersistedPendingEdit {
  return {
    id: edit.id,
    label: edit.label,
    createdAt: edit.createdAt,
    expectedTags: edit.expectedTags,
    edits: edit.edits.map(toPersistedWorkspaceTextEdit),
  };
}

function fromPersistedPendingEdit(edit: PersistedPendingEdit): PendingEdit {
  return {
    id: edit.id,
    label: edit.label,
    createdAt: edit.createdAt,
    expectedTags: edit.expectedTags,
    edits: edit.edits.map(fromPersistedWorkspaceTextEdit),
  };
}

function toPersistedArtifact(artifact: Artifact): PersistedArtifact {
  return {
    id: artifact.id,
    label: artifact.label,
    createdAt: artifact.createdAt,
    filePath: artifact.filePath,
  };
}

function fromPersistedArtifact(artifact: PersistedArtifact): Artifact {
  return {
    id: artifact.id,
    label: artifact.label,
    createdAt: artifact.createdAt,
    content: artifact.content ?? "",
    filePath: artifact.filePath,
  };
}

function toPersistedBashJob(job: BashJob): BashJob {
  if (job.artifactId) {
    const { output: _output, ...withoutOutput } = job;
    return withoutOutput;
  }
  return job;
}

function sanitizePathSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "default";
}

function toPersistedWorkspaceTextEdit(edit: WorkspaceTextEdit): PersistedWorkspaceTextEdit {
  return {
    uri: edit.uri.toString(),
    range: {
      start: { line: edit.range.start.line, character: edit.range.start.character },
      end: { line: edit.range.end.line, character: edit.range.end.character },
    },
    newText: edit.newText,
  };
}

function fromPersistedWorkspaceTextEdit(edit: PersistedWorkspaceTextEdit): WorkspaceTextEdit {
  return {
    uri: vscode.Uri.parse(edit.uri),
    range: new vscode.Range(
      new vscode.Position(edit.range.start.line, edit.range.start.character),
      new vscode.Position(edit.range.end.line, edit.range.end.character),
    ),
    newText: edit.newText,
  };
}
