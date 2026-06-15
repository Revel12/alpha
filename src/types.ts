import * as vscode from "vscode";
import type { ConflictStore } from "./conflictCore";
import type { AlphaTranscriptEntry } from "./transcript";

export type { ConflictStore } from "./conflictCore";

export interface AlphaContext {
  extensionContext: vscode.ExtensionContext;
  sessionKey: string;
  sessionLabel: string;
  compactionSummary?: string;
  compactedThroughHistoryIndex?: number;
  request: vscode.ChatRequest;
  chatContext: vscode.ChatContext;
  transcript: AlphaTranscriptEntry[];
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  pendingEdits: PendingEditStore;
  todos: TodoStore;
  snapshots: FileSnapshotStore;
  artifacts: ArtifactStore;
  bashJobs: BashJobStore;
  conflicts: ConflictStore;
  permissionDecisions: PermissionDecisionStore;
  discoveredTools: DiscoveredToolStore;
  planMode?: PlanModeState;
  blueprintMode?: BlueprintModeState;
  goalMode?: GoalModeState;
  taskDepth?: number;
  taskAllowedSpawns?: string[] | "*" | "";
  taskBlockedAgent?: string;
  taskOutputPrefix?: string;
  persistSession?: () => void;
  setCompaction?: (summary: string, compactedThroughHistoryIndex: number) => void;
  setGoalMode?: (state: GoalModeState | undefined) => void;
}

export interface ToolResult {
  markdown: string;
  details?: unknown;
}

export interface ToolDefinition {
  name: string;
  summary: string;
  run(args: string, ctx: AlphaContext): Promise<ToolResult>;
}

export interface PendingEdit {
  id: string;
  label: string;
  createdAt: string;
  edits: WorkspaceTextEdit[];
  expectedTags?: Record<string, string>;
}

export interface WorkspaceTextEdit {
  uri: vscode.Uri;
  range: vscode.Range;
  newText: string;
}

export interface PendingEditStore {
  list(): PendingEdit[];
  add(edit: Omit<PendingEdit, "id" | "createdAt">): PendingEdit;
  get(id: string): PendingEdit | undefined;
  remove(id: string): void;
  clear(): void;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

export interface TodoCompletionTransition {
  phase: string;
  content: string;
}

export interface TodoStore {
  list(): TodoPhase[];
  set(phases: TodoPhase[]): void;
}

export interface FileSnapshot {
  path: string;
  tag: string;
  content: string;
  createdAt: string;
}

export interface FileSnapshotStore {
  record(path: string, content: string): FileSnapshot;
  get(path: string, tag: string): FileSnapshot | undefined;
  has(path: string, tag: string): boolean;
  list(): FileSnapshot[];
  clear(): void;
}

export interface Artifact {
  id: string;
  label: string;
  content: string;
  createdAt: string;
  filePath?: string;
}

export interface ArtifactStore {
  add(label: string, content: string): Artifact;
  get(id: string): Artifact | undefined;
  list(): Artifact[];
  clear(): void;
}

export type BashJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface BashJob {
  id: string;
  type?: "bash" | "task";
  command: string;
  cwd: string;
  createdAt: string;
  status: BashJobStatus;
  output?: string;
  exitCode?: number | string;
  timedOut?: boolean;
  wallTimeMs?: number;
  artifactId?: string;
  error?: string;
}

export interface BashJobStore {
  add(job: Omit<BashJob, "id" | "createdAt">): BashJob;
  update(id: string, patch: Partial<Omit<BashJob, "id" | "createdAt">>): BashJob | undefined;
  get(id: string): BashJob | undefined;
  list(): BashJob[];
  clear(): void;
}

export type PermissionPersistence = "allow_always" | "reject_always";

export interface PermissionDecisionStore {
  get(key: string): PermissionPersistence | undefined;
  set(key: string, value: PermissionPersistence): void;
  clear(): void;
}

export interface DiscoveredToolStore {
  list(): string[];
  add(names: readonly string[]): string[];
  clear(): void;
}

export interface PlanModeState {
  active: boolean;
  createdAt: string;
  updatedAt: string;
  planPath: string;
  initialPrompt?: string;
  approvedPlan?: string;
  approvedPlanPath?: string;
  pendingApproval?: boolean;
}

export interface BlueprintRound {
  answer: string;
  createdAt: string;
}

export interface BlueprintModeState {
  active: boolean;
  createdAt: string;
  updatedAt: string;
  template: "default" | "concise" | "custom";
  templateSelected: boolean;
  customTemplatePrompt?: string;
  blueprintPath: string;
  originalPrompt: string;
  refinedPrompt: string;
  rounds: BlueprintRound[];
}

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalModeState {
  enabled: boolean;
  mode: "active" | "exiting";
  reason?: "completed";
  goal: Goal;
}
