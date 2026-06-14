import * as fs from "node:fs";
import * as path from "node:path";
import { InMemoryConflictStore } from "./conflictCore";
import { contentTag } from "./hash";
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
  PermissionPersistence,
  TodoItem,
  TodoPhase,
  TodoStore,
} from "./types";

export { InMemoryConflictStore };

export class InMemoryPendingEditStore implements PendingEditStore {
  private edits: PendingEdit[] = [];

  constructor(initial: PendingEdit[] = [], private readonly onChange: () => void = () => undefined) {
    this.edits = [...initial];
  }

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
    this.onChange();
    return created;
  }

  get(id: string): PendingEdit | undefined {
    return this.edits.find((edit) => edit.id === id);
  }

  remove(id: string): void {
    this.edits = this.edits.filter((edit) => edit.id !== id);
    this.onChange();
  }

  clear(): void {
    this.edits = [];
    this.onChange();
  }
}

export class InMemoryTodoStore implements TodoStore {
  private phases: TodoPhase[] = [];

  constructor(initial: TodoPhase[] | TodoItem[] = [], private readonly onChange: () => void = () => undefined) {
    this.phases = normalizeTodoPhases(initial);
  }

  list(): TodoPhase[] {
    return cloneTodoPhases(this.phases);
  }

  set(phases: TodoPhase[]): void {
    this.phases = cloneTodoPhases(phases);
    this.onChange();
  }
}

function normalizeTodoPhases(initial: TodoPhase[] | TodoItem[]): TodoPhase[] {
  if (initial.length === 0) return [];
  const first = initial[0] as Partial<TodoPhase & TodoItem>;
  if (Array.isArray(first.tasks)) {
    return cloneTodoPhases(initial as TodoPhase[]);
  }
  return [{
    name: "Todos",
    tasks: (initial as TodoItem[]).map(cloneTodoItem),
  }];
}

function cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
  return phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map(cloneTodoItem),
  }));
}

function cloneTodoItem(item: TodoItem): TodoItem {
  return { content: item.content, status: item.status };
}

export class InMemoryFileSnapshotStore implements FileSnapshotStore {
  private snapshots = new Map<string, FileSnapshot[]>();

  constructor(initial: FileSnapshot[] = [], private readonly onChange: () => void = () => undefined) {
    for (const snapshot of initial) {
      const existing = this.snapshots.get(snapshot.path) ?? [];
      this.snapshots.set(snapshot.path, [...existing, snapshot].slice(0, 4));
    }
  }

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
    this.onChange();
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
    this.onChange();
  }

  list(): FileSnapshot[] {
    return [...this.snapshots.values()].flat();
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private artifacts: Artifact[] = [];
  private nextId = 0;

  constructor(
    initial: Artifact[] = [],
    private readonly onChange: () => void = () => undefined,
    private readonly artifactDir?: string,
  ) {
    this.artifacts = initial.map((artifact) => this.restoreArtifact(artifact)).slice(0, 100);
    this.includeExistingArtifactFiles();
    this.nextId = this.artifacts.reduce((next, artifact) => {
      const numeric = Number(artifact.id);
      return Number.isInteger(numeric) && numeric >= next ? numeric + 1 : next;
    }, 0);
  }

  add(label: string, content: string): Artifact {
    const id = String(this.nextId++);
    const filePath = this.writeArtifactFile(id, label, content);
    const artifact: Artifact = {
      id,
      label,
      content: filePath ? "" : content,
      createdAt: new Date().toISOString(),
      filePath,
    };
    this.artifacts.unshift(artifact);
    this.artifacts = this.artifacts.slice(0, 100);
    this.onChange();
    return artifact;
  }

  get(id: string): Artifact | undefined {
    const artifact = this.artifacts.find((item) => item.id === id);
    if (!artifact) return undefined;
    return { ...artifact, content: this.readArtifactContent(artifact) };
  }

  list(): Artifact[] {
    return this.artifacts.map((artifact) => ({ ...artifact }));
  }

  clear(): void {
    this.artifacts = [];
    if (this.artifactDir) {
      fs.rmSync(this.artifactDir, { recursive: true, force: true });
    }
    this.onChange();
  }

  private restoreArtifact(artifact: Artifact): Artifact {
    if (artifact.filePath && fs.existsSync(artifact.filePath)) {
      return { ...artifact, content: "" };
    }
    if (this.artifactDir && artifact.content) {
      const filePath = this.writeArtifactFile(artifact.id, artifact.label, artifact.content);
      return { ...artifact, content: filePath ? "" : artifact.content, filePath };
    }
    return { ...artifact };
  }

  private includeExistingArtifactFiles(): void {
    if (!this.artifactDir || !fs.existsSync(this.artifactDir)) return;
    const knownIds = new Set(this.artifacts.map((artifact) => artifact.id));
    const files = fs.readdirSync(this.artifactDir);
    for (const file of files) {
      const match = file.match(/^(\d+)\.(.*)\.log$/);
      if (!match || knownIds.has(match[1])) continue;
      const filePath = path.join(this.artifactDir, file);
      const stat = fs.statSync(filePath);
      this.artifacts.push({
        id: match[1],
        label: match[2].replace(/-/g, " ") || "artifact",
        content: "",
        createdAt: stat.mtime.toISOString(),
        filePath,
      });
    }
    this.artifacts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private writeArtifactFile(id: string, label: string, content: string): string | undefined {
    if (!this.artifactDir) return undefined;
    fs.mkdirSync(this.artifactDir, { recursive: true });
    const filePath = path.join(this.artifactDir, `${id}.${sanitizeArtifactLabel(label)}.log`);
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  private readArtifactContent(artifact: Artifact): string {
    if (!artifact.filePath) return artifact.content;
    return fs.readFileSync(artifact.filePath, "utf8");
  }
}

function sanitizeArtifactLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "artifact";
}

export class InMemoryBashJobStore implements BashJobStore {
  private jobs: BashJob[] = [];

  constructor(initial: BashJob[] = [], private readonly onChange: () => void = () => undefined) {
    this.jobs = [...initial].slice(0, 100);
  }

  add(job: Omit<BashJob, "id" | "createdAt">): BashJob {
    const created: BashJob = {
      ...job,
      id: `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    this.jobs.unshift(created);
    this.jobs = this.jobs.slice(0, 100);
    this.onChange();
    return created;
  }

  update(id: string, patch: Partial<Omit<BashJob, "id" | "createdAt">>): BashJob | undefined {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index === -1) return undefined;
    this.jobs[index] = { ...this.jobs[index], ...patch };
    this.onChange();
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
    this.onChange();
  }
}

export class InMemoryPermissionDecisionStore implements PermissionDecisionStore {
  private readonly decisions = new Map<string, PermissionPersistence>();

  get(key: string): PermissionPersistence | undefined {
    return this.decisions.get(key);
  }

  set(key: string, value: PermissionPersistence): void {
    this.decisions.set(key, value);
  }

  clear(): void {
    this.decisions.clear();
  }
}

export class InMemoryDiscoveredToolStore implements DiscoveredToolStore {
  private names = new Set<string>();

  constructor(initial: string[] = [], private readonly onChange: () => void = () => undefined) {
    for (const name of initial) this.names.add(name);
  }

  list(): string[] {
    return [...this.names].sort();
  }

  add(names: readonly string[]): string[] {
    const added: string[] = [];
    for (const name of names) {
      if (this.names.has(name)) continue;
      this.names.add(name);
      added.push(name);
    }
    if (added.length > 0) this.onChange();
    return added;
  }

  clear(): void {
    if (this.names.size === 0) return;
    this.names.clear();
    this.onChange();
  }
}
