import { contentTag } from "./hash";
import type {
  Artifact,
  ArtifactStore,
  BashJob,
  BashJobStore,
  FileSnapshot,
  FileSnapshotStore,
  PendingEdit,
  PendingEditStore,
  TodoItem,
  TodoStore,
} from "./types";

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

export class InMemoryArtifactStore implements ArtifactStore {
  private artifacts: Artifact[] = [];

  add(label: string, content: string): Artifact {
    const artifact: Artifact = {
      id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label,
      content,
      createdAt: new Date().toISOString(),
    };
    this.artifacts.unshift(artifact);
    this.artifacts = this.artifacts.slice(0, 100);
    return artifact;
  }

  get(id: string): Artifact | undefined {
    return this.artifacts.find((artifact) => artifact.id === id);
  }

  list(): Artifact[] {
    return [...this.artifacts];
  }

  clear(): void {
    this.artifacts = [];
  }
}

export class InMemoryBashJobStore implements BashJobStore {
  private jobs: BashJob[] = [];

  add(job: Omit<BashJob, "id" | "createdAt">): BashJob {
    const created: BashJob = {
      ...job,
      id: `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    this.jobs.unshift(created);
    this.jobs = this.jobs.slice(0, 100);
    return created;
  }

  update(id: string, patch: Partial<Omit<BashJob, "id" | "createdAt">>): BashJob | undefined {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index === -1) return undefined;
    this.jobs[index] = { ...this.jobs[index], ...patch };
    return this.jobs[index];
  }

  get(id: string): BashJob | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  list(): BashJob[] {
    return [...this.jobs];
  }

  clear(): void {
    this.jobs = [];
  }
}
