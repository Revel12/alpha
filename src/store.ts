import { contentTag } from "./hash";
import type { FileSnapshot, FileSnapshotStore, PendingEdit, PendingEditStore, TodoItem, TodoStore } from "./types";

export class InMemoryPendingEditStore implements PendingEditStore {
  private edits: PendingEdit[] = [];

  list(): PendingEdit[] {
    return [...this.edits];
  }

  add(edit: Omit<PendingEdit, "id" | "createdAt">): PendingEdit {
    const created: PendingEdit = {
      ...edit,
      id: `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    this.edits.push(created);
    return created;
  }

  get(id: string): PendingEdit | undefined {
    return this.edits.find((edit) => edit.id === id);
  }

  remove(id: string): void {
    this.edits = this.edits.filter((edit) => edit.id !== id);
  }

  clear(): void {
    this.edits = [];
  }
}

export class InMemoryTodoStore implements TodoStore {
  private items: TodoItem[] = [];

  list(): TodoItem[] {
    return [...this.items];
  }

  set(items: TodoItem[]): void {
    this.items = [...items];
  }
}

export class InMemoryFileSnapshotStore implements FileSnapshotStore {
  private snapshots = new Map<string, FileSnapshot[]>();

  record(path: string, content: string): FileSnapshot {
    const snapshot: FileSnapshot = {
      path,
      tag: contentTag(content),
      content,
      createdAt: new Date().toISOString(),
    };
    const existing = this.snapshots.get(path) ?? [];
    const withoutDuplicate = existing.filter((item) => item.tag !== snapshot.tag);
    this.snapshots.set(path, [snapshot, ...withoutDuplicate].slice(0, 4));
    return snapshot;
  }

  get(path: string, tag: string): FileSnapshot | undefined {
    return this.snapshots.get(path)?.find((snapshot) => snapshot.tag === tag.toUpperCase());
  }

  has(path: string, tag: string): boolean {
    return this.get(path, tag) !== undefined;
  }

  clear(): void {
    this.snapshots.clear();
  }
}
