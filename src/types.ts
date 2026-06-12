import * as vscode from "vscode";

export interface AlphaContext {
  extensionContext: vscode.ExtensionContext;
  request: vscode.ChatRequest;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  pendingEdits: PendingEditStore;
  todos: TodoStore;
  snapshots: FileSnapshotStore;
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
