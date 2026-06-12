import type { PendingEdit, PendingEditStore, TodoItem, TodoStore } from "./types";

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
