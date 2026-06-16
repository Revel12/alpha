import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  InMemoryArtifactStore,
  InMemoryBashJobStore,
  InMemoryConflictStore,
  InMemoryDiscoveredToolStore,
  InMemoryFileSnapshotStore,
  InMemoryPendingEditStore,
  InMemoryPermissionDecisionStore,
  InMemoryTodoStore,
} from "./store";
import { buildAlphaTranscript, firstUserPromptFromTranscript, type AlphaTranscriptEntry } from "./transcript";
import type {
  Artifact,
  ArtifactStore,
  BashJob,
  BashJobStore,
  ConflictStore,
  DiscoveredToolStore,
  FileSnapshot,
  FileSnapshotStore,
  PendingEdit,
  PendingEditStore,
  PlanModeState,
  BlueprintModeState,
  GoalModeState,
  AlphaThinkingEffort,
  PermissionDecisionStore,
  TodoItem,
  TodoPhase,
  TodoStore,
  WorkspaceTextEdit,
} from "./types";
import { workspaceFolders } from "./workspace";

const STORAGE_KEY = "alpha.sessions.v1";
const MAX_PERSISTED_SESSIONS = 25;
const DEFAULT_SESSION_STORAGE_PATH = ".alpha/sessions.json";

export interface AlphaSessionState {
  key: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  compactionSummary?: string;
  compactedThroughHistoryIndex?: number;
  pendingEdits: PendingEditStore;
  todos: TodoStore;
  snapshots: FileSnapshotStore;
  artifacts: ArtifactStore;
  bashJobs: BashJobStore;
  conflicts: ConflictStore;
  permissionDecisions: PermissionDecisionStore;
  discoveredTools: DiscoveredToolStore;
  terminalTranscript?: AlphaTranscriptEntry[];
  terminalThinkingEffort?: AlphaThinkingEffort;
  planMode?: PlanModeState;
  blueprintMode?: BlueprintModeState;
  goalMode?: GoalModeState;
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

  getTerminal(key?: string): AlphaSessionState {
    const baseKey = terminalBaseKey();
    const requested = key && isTerminalSessionKey(key, baseKey) ? this.byKey.get(key) : undefined;
    if (requested) {
      this.touch(requested);
      this.latestKey = requested.key;
      return requested;
    }

    const newest = this.terminalSessions()[0];
    if (newest) {
      this.touch(newest);
      this.latestKey = newest.key;
      return newest;
    }

    let state = this.byKey.get(baseKey);
    if (!state) {
      state = createSessionState(baseKey, "Alpha terminal", () => this.persistSoon(), undefined, artifactDirForSession(this.extensionContext, baseKey));
      state.terminalTranscript = [];
      this.byKey.set(baseKey, state);
      this.persistSoon();
    }
    this.touch(state);
    this.latestKey = state.key;
    return state;
  }

  createTerminal(label?: string): AlphaSessionState {
    const baseKey = terminalBaseKey();
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const key = `${baseKey}:${suffix}`;
    const state = createSessionState(key, cleanSessionLabel(label) || "Alpha terminal", () => this.persistSoon(), undefined, artifactDirForSession(this.extensionContext, key));
    state.terminalTranscript = [];
    this.byKey.set(key, state);
    this.touch(state);
    this.latestKey = state.key;
    return state;
  }

  forkTerminal(sourceKey: string, label?: string): AlphaSessionState | undefined {
    const baseKey = terminalBaseKey();
    if (!isTerminalSessionKey(sourceKey, baseKey)) return undefined;
    const source = this.byKey.get(sourceKey);
    if (!source) return undefined;

    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const key = `${baseKey}:${suffix}`;
    const now = new Date().toISOString();
    const persisted = {
      ...toPersistedSession(source),
      key,
      label: cleanSessionLabel(label) || `${source.label} fork`,
      createdAt: now,
      updatedAt: now,
      bashJobs: source.bashJobs.list().filter((job) => job.status !== "running").map(toPersistedBashJob),
    };
    const state = createSessionState(key, persisted.label, () => this.persistSoon(), persisted, artifactDirForSession(this.extensionContext, key));
    state.terminalTranscript = [...(source.terminalTranscript ?? [])];
    this.byKey.set(key, state);
    this.touch(state);
    this.latestKey = state.key;
    return state;
  }

  terminalSessions(): AlphaSessionState[] {
    const baseKey = terminalBaseKey();
    return [...this.byKey.values()]
      .filter((state) => isTerminalSessionKey(state.key, baseKey))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  renameTerminal(key: string, label: string): AlphaSessionState | undefined {
    const baseKey = terminalBaseKey();
    if (!isTerminalSessionKey(key, baseKey)) return undefined;
    const state = this.byKey.get(key);
    if (!state) return undefined;
    state.label = cleanSessionLabel(label) || state.label;
    this.touch(state);
    return state;
  }

  deleteTerminal(key: string): AlphaSessionState | undefined {
    const baseKey = terminalBaseKey();
    if (!isTerminalSessionKey(key, baseKey)) return undefined;
    const state = this.byKey.get(key);
    if (!state) return undefined;
    state.pendingEdits.clear();
    state.snapshots.clear();
    state.artifacts.clear();
    state.bashJobs.clear();
    state.conflicts.clear();
    state.permissionDecisions.clear();
    state.discoveredTools.clear();
    this.byKey.delete(key);
    if (this.latestKey === key) {
      this.latestKey = this.terminalSessions()[0]?.key ?? this.list()[0]?.key;
    }
    this.persistSoon();
    return state;
  }

  clearTerminal(key: string): AlphaSessionState | undefined {
    const baseKey = terminalBaseKey();
    if (!isTerminalSessionKey(key, baseKey)) return undefined;
    const state = this.byKey.get(key);
    if (!state) return undefined;
    state.compactionSummary = undefined;
    state.compactedThroughHistoryIndex = undefined;
    state.terminalTranscript = [];
    state.pendingEdits.clear();
    state.todos.set([]);
    state.snapshots.clear();
    state.artifacts.clear();
    state.bashJobs.clear();
    state.conflicts.clear();
    state.permissionDecisions.clear();
    state.discoveredTools.clear();
    state.planMode = undefined;
    state.blueprintMode = undefined;
    state.goalMode = undefined;
    this.touch(state);
    return state;
  }

  getTerminalByOrdinal(ordinal: number): AlphaSessionState | undefined {
    if (!Number.isInteger(ordinal) || ordinal < 1) return undefined;
    return this.terminalSessions()[ordinal - 1];
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
      state.conflicts.clear();
      state.permissionDecisions.clear();
      state.discoveredTools.clear();
    }
    this.byKey.clear();
    this.latestKey = undefined;
    void this.extensionContext.workspaceState.update(STORAGE_KEY, undefined);
    deleteSessionStorageFile(this.extensionContext);
  }

  persistNow(): void {
    const persisted = this.toPersisted();
    writeSessionStorageFile(this.extensionContext, persisted);
    void this.extensionContext.workspaceState.update(STORAGE_KEY, persisted);
  }

  private touch(state: AlphaSessionState): void {
    state.updatedAt = new Date().toISOString();
    this.persistSoon();
  }

  private persistSoon(): void {
    queueMicrotask(() => this.persistNow());
  }

  private restore(): void {
    const filePersisted = readSessionStorageFile(this.extensionContext);
    const workspacePersisted = this.extensionContext.workspaceState.get<PersistedSessionRoot>(STORAGE_KEY);
    const persisted = newestPersistedRoot(filePersisted, workspacePersisted);
    if (!persisted?.sessions?.length) return;
    for (const raw of prunePersistedSessions(persisted.sessions).slice(0, MAX_PERSISTED_SESSIONS)) {
      const state = createSessionState(raw.key, raw.label, () => this.persistSoon(), raw, artifactDirForSession(this.extensionContext, raw.key));
      this.byKey.set(state.key, state);
    }
    this.latestKey = persisted.latestKey && this.byKey.has(persisted.latestKey) ? persisted.latestKey : this.list()[0]?.key;
    this.persistSoon();
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

function readSessionStorageFile(extensionContext: vscode.ExtensionContext): PersistedSessionRoot | undefined {
  const filePath = sessionStorageFilePath(extensionContext);
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isPersistedSessionRoot(parsed)) return undefined;
    return parsed;
  } catch (error) {
    console.warn(`Alpha could not read session storage file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function writeSessionStorageFile(extensionContext: vscode.ExtensionContext, persisted: PersistedSessionRoot): void {
  const filePath = sessionStorageFilePath(extensionContext);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(persisted, undefined, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    console.warn(`Alpha could not write session storage file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function deleteSessionStorageFile(extensionContext: vscode.ExtensionContext): void {
  const filePath = sessionStorageFilePath(extensionContext);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.warn(`Alpha could not delete session storage file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sessionStorageFilePath(extensionContext: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration("alpha").get<string>("session.storagePath", DEFAULT_SESSION_STORAGE_PATH).trim() || DEFAULT_SESSION_STORAGE_PATH;
  if (path.isAbsolute(configured)) return configured;

  const [firstWorkspace] = workspaceFolders();
  if (firstWorkspace) return path.join(firstWorkspace.uri.fsPath, configured);

  return path.join(extensionContext.globalStorageUri.fsPath, configured);
}

function newestPersistedRoot(
  left: PersistedSessionRoot | undefined,
  right: PersistedSessionRoot | undefined,
): PersistedSessionRoot | undefined {
  if (!left) return right;
  if (!right) return left;
  return newestSessionTimestamp(right) > newestSessionTimestamp(left) ? right : left;
}

function newestSessionTimestamp(root: PersistedSessionRoot): number {
  return root.sessions.reduce((newest, session) => {
    const touchedMs = Date.parse(session.updatedAt);
    return Number.isFinite(touchedMs) ? Math.max(newest, touchedMs) : newest;
  }, 0);
}

function isPersistedSessionRoot(value: unknown): value is PersistedSessionRoot {
  if (!value || typeof value !== "object") return false;
  const root = value as Partial<PersistedSessionRoot>;
  return root.version === 1 && Array.isArray(root.sessions);
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
    compactedThroughHistoryIndex: persisted?.compactedThroughHistoryIndex,
    pendingEdits: new InMemoryPendingEditStore((persisted?.pendingEdits ?? []).map(fromPersistedPendingEdit), notifyChanged),
    todos: new InMemoryTodoStore(persisted?.todos ?? [], notifyChanged),
    snapshots: new InMemoryFileSnapshotStore(persisted?.snapshots ?? [], notifyChanged),
    artifacts: new InMemoryArtifactStore((persisted?.artifacts ?? []).map(fromPersistedArtifact), notifyChanged, artifactDir),
    bashJobs: new InMemoryBashJobStore(persisted?.bashJobs ?? [], notifyChanged),
    conflicts: new InMemoryConflictStore([], notifyChanged),
    permissionDecisions: new InMemoryPermissionDecisionStore(),
    discoveredTools: new InMemoryDiscoveredToolStore(persisted?.discoveredTools ?? [], notifyChanged),
    terminalTranscript: persisted?.terminalTranscript,
    terminalThinkingEffort: persisted?.terminalThinkingEffort,
    planMode: persisted?.planMode,
    blueprintMode: persisted?.blueprintMode,
    goalMode: persisted?.goalMode,
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
    compactedThroughHistoryIndex: state.compactedThroughHistoryIndex,
    pendingEdits: state.pendingEdits.list().map(toPersistedPendingEdit),
    todos: state.todos.list(),
    snapshots: state.snapshots.list(),
    artifacts: state.artifacts.list().map(toPersistedArtifact),
    bashJobs: state.bashJobs.list().map(toPersistedBashJob),
    discoveredTools: state.discoveredTools.list(),
    terminalTranscript: state.terminalTranscript,
    terminalThinkingEffort: state.terminalThinkingEffort,
    planMode: state.planMode,
    blueprintMode: state.blueprintMode,
    goalMode: state.goalMode,
  };
}

function artifactDirForSession(extensionContext: vscode.ExtensionContext, key: string): string {
  const root = extensionContext.storageUri ?? extensionContext.globalStorageUri;
  return path.join(root.fsPath, "alpha-artifacts", sanitizePathSegment(key));
}

function terminalBaseKey(): string {
  const workspaceKey = workspaceFolders().map((folder) => folder.uri.toString()).sort().join("|") || "no-workspace";
  return `${workspaceKey}#terminal`;
}

function isTerminalSessionKey(key: string, baseKey: string): boolean {
  return key === baseKey || key.startsWith(`${baseKey}:`);
}

function cleanSessionLabel(label: string | undefined): string {
  return (label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
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
  compactedThroughHistoryIndex?: number;
  pendingEdits?: PersistedPendingEdit[];
  todos?: TodoPhase[] | TodoItem[];
  snapshots?: FileSnapshot[];
  artifacts?: PersistedArtifact[];
  bashJobs?: BashJob[];
  discoveredTools?: string[];
  terminalTranscript?: AlphaTranscriptEntry[];
  terminalThinkingEffort?: AlphaThinkingEffort;
  planMode?: PlanModeState;
  blueprintMode?: BlueprintModeState;
  goalMode?: GoalModeState;
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
