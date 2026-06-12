import * as vscode from "vscode";

export interface AlphaContext {
  extensionContext: vscode.ExtensionContext;
  request: vscode.ChatRequest;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  pendingEdits: PendingEditStore;
  todos: TodoStore;
  snapshots: FileSnapshotStore;
  artifacts: ArtifactStore;
  bashJobs: BashJobStore;
}

export interface ToolResult {
  markdown: string;
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

export interface TodoStore {
  list(): TodoItem[];
  set(items: TodoItem[]): void;
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
  clear(): void;
}

export interface Artifact {
  id: string;
  label: string;
  content: string;
  createdAt: string;
}

export interface ArtifactStore {
  add(label: string, content: string): Artifact;
  get(id: string): Artifact | undefined;
  list(): Artifact[];
  clear(): void;
}

export type BashJobStatus = "running" | "completed" | "failed";

export interface BashJob {
  id: string;
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
