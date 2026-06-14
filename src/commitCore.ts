import { spawn } from "node:child_process";

export type CommitType = "feat" | "fix" | "refactor" | "perf" | "docs" | "test" | "build" | "ci" | "chore" | "style" | "revert";

export interface CommitCommandArgs {
  dryRun: boolean;
  push: boolean;
  ticket?: string;
  context?: string;
}

export interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
}

export interface GitOverviewSnapshot {
  files: string[];
  stat: string;
  numstat: NumstatEntry[];
  scopeCandidates: string;
  isWideScope: boolean;
  excludedFiles?: string[];
}

export interface ConventionalDetail {
  text: string;
  userVisible?: boolean;
}

export interface CommitProposal {
  type: CommitType;
  scope: string | null;
  summary: string;
  details: ConventionalDetail[];
  issueRefs: string[];
  warnings: string[];
}

export type HunkSelector =
  | { type: "all" }
  | { type: "indices"; indices: number[] }
  | { type: "lines"; start: number; end: number };

export interface FileChange {
  path: string;
  hunks: HunkSelector;
}

export interface SplitCommitGroup {
  changes: FileChange[];
  type: CommitType;
  scope: string | null;
  summary: string;
  details: ConventionalDetail[];
  issueRefs: string[];
  rationale?: string;
  dependencies: number[];
}

export interface SplitCommitPlan {
  commits: SplitCommitGroup[];
  warnings: string[];
}

export type CommitPlan = { kind: "single"; proposal: CommitProposal } | { kind: "split"; plan: SplitCommitPlan };

export interface CommitAgentState {
  overview?: GitOverviewSnapshot;
  diffText?: string;
  proposal?: CommitProposal;
  splitProposal?: SplitCommitPlan;
  diffCache?: Map<string, string>;
}

export interface DiffHunk {
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface FileDiffChunk {
  path: string;
  headerLines: string[];
  hunks: DiffHunk[];
  raw: string;
  isBinary: boolean;
}

export interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  warnings: string[];
  proposal?: T;
}

const COMMIT_TYPES: ReadonlySet<string> = new Set(["feat", "fix", "refactor", "perf", "docs", "test", "build", "ci", "chore", "style", "revert"]);
const SUMMARY_MAX_CHARS = 72;
const MAX_DETAIL_ITEMS = 6;
const TICKET_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const LOCK_FILE_NAMES = new Set([
  "Cargo.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "composer.lock",
  "Gemfile.lock",
  "flake.lock",
  "pubspec.lock",
  "Podfile.lock",
  "mix.lock",
  "gradle.lockfile",
]);

const HIGH_PRIORITY_EXTENSIONS = new Set([".rs", ".go", ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".h", ".hpp"]);
const SHELL_SQL_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".sql"]);
const MANIFEST_FILES = new Set(["Cargo.toml", "package.json", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile", "build.gradle", "pom.xml"]);
const LOW_PRIORITY_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml", ".csv"]);
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".dylib"]);
const TEST_PATTERNS = ["/test/", "/tests/", "/__tests__/", "_test.", ".test.", ".spec.", "_spec."];
const FILLER_WORDS = ["comprehensive", "various", "several", "improved", "enhanced", "better"];
const META_PHRASES = ["this commit", "this change", "updated code", "modified files"];
const PAST_TENSE_VERBS = new Set([
  "added",
  "adjusted",
  "aligned",
  "bumped",
  "changed",
  "cleaned",
  "clarified",
  "consolidated",
  "converted",
  "corrected",
  "created",
  "deployed",
  "deprecated",
  "disabled",
  "documented",
  "dropped",
  "enabled",
  "expanded",
  "extracted",
  "fixed",
  "hardened",
  "implemented",
  "improved",
  "integrated",
  "introduced",
  "migrated",
  "moved",
  "optimized",
  "patched",
  "prevented",
  "reduced",
  "refactored",
  "removed",
  "renamed",
  "reorganized",
  "replaced",
  "resolved",
  "restored",
  "restructured",
  "reworked",
  "secured",
  "simplified",
  "stabilized",
  "standardized",
  "streamlined",
  "tightened",
  "tuned",
  "updated",
  "upgraded",
  "validated",
]);
const PAST_TENSE_ED_EXCEPTIONS = new Set(["hundred", "red", "bed"]);

export function parseCommitCommandArgs(input: string): CommitCommandArgs {
  const tokens = shellSplit(input);
  const args: CommitCommandArgs = { dryRun: false, push: false };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--push") {
      args.push = true;
    } else if (token === "--no-changelog") {
      continue;
    } else if (token === "--context" || token === "-c") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${token} requires a value.`);
      args.context = value;
      index += 1;
    } else if (token === "--ticket" || token === "-t") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${token} requires a value.`);
      args.ticket = normalizeTicket(value);
      index += 1;
    } else if (token.startsWith("--ticket=")) {
      args.ticket = normalizeTicket(token.slice("--ticket=".length));
    } else if (token === "--model" || token === "-m") {
      index += 1;
    } else if (token === "--help" || token === "-h") {
      continue;
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown /commit flag: ${token}`);
    } else {
      args.context = [args.context, token].filter(Boolean).join(" ");
    }
  }
  return args;
}

export async function ensureStagedChanges(cwd: string): Promise<{ stagedFiles: string[]; autoStaged: boolean }> {
  let stagedFiles = await changedFiles(cwd, true);
  if (stagedFiles.length > 0) return { stagedFiles, autoStaged: false };
  await git(cwd, ["add", "-A"]);
  stagedFiles = await changedFiles(cwd, true);
  return { stagedFiles, autoStaged: true };
}

export async function buildGitOverview(cwd: string, staged = true): Promise<GitOverviewSnapshot> {
  const allFiles = await changedFiles(cwd, staged);
  const { filtered, excluded } = filterExcludedFiles(allFiles);
  const stat = await git(cwd, ["diff", staged ? "--cached" : "", "--stat"].filter(Boolean));
  const numstat = parseNumstat(await git(cwd, ["diff", staged ? "--cached" : "", "--numstat"].filter(Boolean))).filter((entry) => !isExcludedLockFile(entry.path));
  const scopeCandidates = extractScopeCandidates(numstat);
  return {
    files: filtered,
    stat,
    numstat,
    scopeCandidates: scopeCandidates.join(", "),
    isWideScope: scopeCandidates.length > 2,
    excludedFiles: excluded.length ? excluded : undefined,
  };
}

export async function changedFiles(cwd: string, staged = true): Promise<string[]> {
  const out = await git(cwd, ["diff", staged ? "--cached" : "", "--name-only"].filter(Boolean));
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function fileDiff(cwd: string, files: string[], staged = true): Promise<string> {
  const parts: string[] = [];
  const sorted = [...files].sort((a, b) => getFilePriority(b) - getFilePriority(a));
  for (const file of sorted) {
    const diff = await git(cwd, ["diff", staged ? "--cached" : "", "--", file].filter(Boolean));
    if (diff) parts.push(`=== ${file} ===\n${truncateDiff(diff)}`);
  }
  return parts.join("\n\n") || "(no diff)";
}

export async function recentCommits(cwd: string, count = 12): Promise<string> {
  return git(cwd, ["log", "--oneline", "-n", String(Math.max(1, Math.min(50, count)))]);
}

export function parseDiffChunks(diffText: string): FileDiffChunk[] {
  const chunks = diffText.split(/^diff --git /m).filter(Boolean).map((chunk) => `diff --git ${chunk}`);
  return chunks.map(parseDiffChunk).filter((chunk): chunk is FileDiffChunk => chunk !== undefined);
}

export function getFilePriority(filename: string): number {
  const basename = filename.split("/").pop() ?? filename;
  const ext = basename.includes(".") ? `.${basename.split(".").pop()}` : "";
  if (BINARY_EXTENSIONS.has(ext)) return -100;
  const lowerPath = filename.toLowerCase();
  for (const pattern of TEST_PATTERNS) {
    if (lowerPath.includes(pattern)) return 10;
  }
  if (LOW_PRIORITY_EXTENSIONS.has(ext) && !MANIFEST_FILES.has(basename)) return 20;
  if (MANIFEST_FILES.has(basename)) return 70;
  if (SHELL_SQL_EXTENSIONS.has(ext)) return 80;
  if (HIGH_PRIORITY_EXTENSIONS.has(ext)) return 100;
  return 50;
}

export function validateCommitProposal(params: unknown, stagedFiles: string[], diffText = ""): ValidationResult<CommitProposal> {
  const parsed = parseCommitProposalInput(params);
  if ("errors" in parsed) return { valid: false, errors: parsed.errors, warnings: [] };
  const proposal = parsed.value;
  const summary = normalizeSummary(proposal.summary, proposal.type, proposal.scope);
  const details = capDetails(proposal.details);
  const errors = [
    ...validateSummaryRules(summary).errors,
    ...validateScope(proposal.scope),
    ...validateTypeConsistency(proposal.type, stagedFiles, { diffText, summary, details: details.details }).errors,
  ];
  const warnings = [
    ...validateSummaryRules(summary).warnings,
    ...details.warnings,
    ...validateTypeConsistency(proposal.type, stagedFiles, { diffText, summary, details: details.details }).warnings,
  ];
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    proposal: errors.length === 0 ? { ...proposal, summary, details: details.details, warnings } : undefined,
  };
}

export function validateSplitCommitPlan(params: unknown, stagedFiles: string[], diffText: string): ValidationResult<SplitCommitPlan> {
  const parsed = parseSplitCommitInput(params);
  if ("errors" in parsed) return { valid: false, errors: parsed.errors, warnings: [] };
  const filteredStagedFiles = filterExcludedFiles(stagedFiles).filtered;
  const stagedSet = new Set(filteredStagedFiles);
  const usedFiles = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  const chunks = parseDiffChunks(diffText);
  const commits = parsed.value.commits.map((commit, index) => {
    const scope = commit.scope?.trim() || null;
    const summary = normalizeSummary(commit.summary, commit.type, scope);
    const detailResult = capDetails(commit.details);
    warnings.push(...detailResult.warnings.map((warning) => `Commit ${index + 1}: ${warning}`));
    errors.push(...validateSummaryRules(summary).errors.map((error) => `Commit ${index + 1}: ${error}`));
    warnings.push(...validateSummaryRules(summary).warnings.map((warning) => `Commit ${index + 1}: ${warning}`));
    errors.push(...validateScope(scope).map((error) => `Commit ${index + 1}: ${error}`));
    const typeValidation = validateTypeConsistency(commit.type, commit.changes.map((change) => change.path), {
      diffText,
      summary,
      details: detailResult.details,
    });
    errors.push(...typeValidation.errors.map((error) => `Commit ${index + 1}: ${error}`));
    warnings.push(...typeValidation.warnings.map((warning) => `Commit ${index + 1}: ${warning}`));
    errors.push(...validateDependencies(index, commit.dependencies, parsed.value.commits.length));
    errors.push(...validateHunkSelectors(index, commit.changes, chunks));
    return {
      ...commit,
      scope,
      summary,
      details: detailResult.details,
    };
  });

  for (const commit of commits) {
    const seen = new Set<string>();
    for (const change of commit.changes) {
      if (!stagedSet.has(change.path)) {
        errors.push(`File not staged: ${change.path}`);
        continue;
      }
      if (seen.has(change.path)) {
        errors.push(`File listed multiple times in commit ${commit.summary}: ${change.path}`);
        continue;
      }
      if (usedFiles.has(change.path)) {
        errors.push(`File appears in multiple commits: ${change.path}`);
        continue;
      }
      seen.add(change.path);
      usedFiles.add(change.path);
    }
  }

  for (const file of filteredStagedFiles) {
    if (!usedFiles.has(file)) errors.push(`Staged file missing from split plan: ${file}`);
  }

  const dependencyOrder = computeDependencyOrder(commits);
  if ("error" in dependencyOrder) errors.push(dependencyOrder.error);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    proposal: errors.length === 0 ? { commits, warnings } : undefined,
  };
}

export function computeDependencyOrder(groups: Array<{ dependencies?: number[] }>): number[] | { error: string } {
  const total = groups.length;
  const inDegree = new Array<number>(total).fill(0);
  const edges = Array.from({ length: total }, () => new Set<number>());
  for (let index = 0; index < total; index++) {
    for (const dependency of groups[index].dependencies ?? []) {
      if (dependency < 0 || dependency >= total) return { error: `Invalid dependency index: ${dependency}` };
      if (!edges[dependency].has(index)) {
        edges[dependency].add(index);
        inDegree[index] += 1;
      }
    }
  }
  const queue: number[] = [];
  for (let index = 0; index < total; index++) {
    if (inDegree[index] === 0) queue.push(index);
  }
  const order: number[] = [];
  while (queue.length) {
    const current = queue.shift();
    if (current === undefined) break;
    order.push(current);
    for (const next of edges[current]) {
      inDegree[next] -= 1;
      if (inDegree[next] === 0) queue.push(next);
    }
  }
  return order.length === total ? order : { error: "Circular dependency detected in split commit plan." };
}

export async function executeCommitPlan(cwd: string, plan: CommitPlan, options: { push: boolean; ticket?: string }): Promise<string> {
  if (plan.kind === "single") {
    const message = formatCommitMessage(plan.proposal, options);
    await git(cwd, ["commit", "-m", message]);
    if (options.push) await git(cwd, ["push"]);
    return `Commit created.\n\n${message}${options.push ? "\n\nPushed to remote." : ""}`;
  }

  const order = computeDependencyOrder(plan.plan.commits);
  if ("error" in order) throw new Error(order.error);
  const stagedDiff = await git(cwd, ["diff", "--cached"]);
  await git(cwd, ["reset"]);
  const messages: string[] = [];
  for (const commitIndex of order) {
    const commit = plan.plan.commits[commitIndex];
    await stageCommitChanges(cwd, stagedDiff, commit.changes);
    const message = formatCommitMessage(commit, options);
    await git(cwd, ["commit", "-m", message]);
    messages.push(message);
    await git(cwd, ["reset"]);
  }
  if (options.push) await git(cwd, ["push"]);
  return [`Split commits created (${messages.length}).`, "", ...messages.map((message, index) => `Commit ${index + 1}:\n${message}`), options.push ? "\nPushed to remote." : ""].filter(Boolean).join("\n\n");
}

export function formatCommitPlan(plan: CommitPlan, options: { ticket?: string } = {}): string {
  if (plan.kind === "single") {
    return ["Generated commit message:", "", formatCommitMessage(plan.proposal, options), formatWarnings(plan.proposal.warnings)].filter(Boolean).join("\n");
  }
  return [
    "Split commit plan:",
    "",
    ...plan.plan.commits.map((commit, index) => [`Commit ${index + 1}:`, formatCommitMessage(commit, options), `Changes: ${commit.changes.map((change) => formatFileChangeSummary(change)).join(", ")}`].join("\n")),
    formatWarnings(plan.plan.warnings),
  ].filter(Boolean).join("\n\n");
}

export function formatCommitMessage(input: Pick<CommitProposal, "type" | "scope" | "summary" | "details">, options: { ticket?: string } = {}): string {
  const scopePart = input.scope ? `(${input.scope})` : "";
  const conventionalHeader = `${input.type}${scopePart}: ${input.summary}`;
  const header = options.ticket ? `${options.ticket}: ${input.summary}` : conventionalHeader;
  const bodyLines = input.details.map((detail) => `- ${detail.text.trim()}`);
  return bodyLines.length ? `${header}\n\n${bodyLines.join("\n")}` : header;
}

export function normalizeTicket(ticket: string): string {
  const normalized = ticket.trim().toUpperCase();
  if (!TICKET_PATTERN.test(normalized)) {
    throw new Error(`Invalid ticket "${ticket}". Expected format like SMAD-150.`);
  }
  return normalized;
}

export async function git(cwd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git ${args.join(" ")} exited ${code}`));
      }
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function stageCommitChanges(cwd: string, stagedDiff: string, changes: FileChange[]): Promise<void> {
  const chunks = parseDiffChunks(stagedDiff);
  for (const change of changes) {
    const patch = buildPatchForChange(chunks, change);
    if (!patch.trim()) throw new Error(`No patch found for ${change.path}`);
    await git(cwd, ["apply", "--cached"], patch);
  }
}

export function buildPatchForChange(chunks: FileDiffChunk[], change: FileChange): string {
  const chunk = chunks.find((item) => item.path === change.path);
  if (!chunk) return "";
  if (change.hunks.type === "all" || chunk.isBinary) return ensureTrailingNewline(chunk.raw);
  const selected = selectHunks(chunk.hunks, change.hunks);
  if (!selected.length) return "";
  return ensureTrailingNewline([...chunk.headerLines, ...selected.flatMap((hunk) => hunk.content.split("\n"))].join("\n"));
}

function selectHunks(hunks: DiffHunk[], selector: HunkSelector): DiffHunk[] {
  if (selector.type === "all") return hunks;
  if (selector.type === "indices") {
    const wanted = new Set(selector.indices.map((value) => Math.max(1, Math.floor(value))));
    return hunks.filter((hunk) => wanted.has(hunk.index + 1));
  }
  return hunks.filter((hunk) => hunk.newStart <= selector.end && hunk.newStart + Math.max(1, hunk.newLines) - 1 >= selector.start);
}

function parseDiffChunk(raw: string): FileDiffChunk | undefined {
  const lines = raw.replace(/\n$/, "").split("\n");
  const header = lines[0]?.match(/^diff --git a\/(.+?) b\/(.+)/);
  if (!header) return undefined;
  const filePath = header[2];
  const firstHunkIndex = lines.findIndex((line) => line.startsWith("@@ "));
  const isBinary = lines.some((line) => line.startsWith("Binary files "));
  const headerLines = firstHunkIndex === -1 ? lines : lines.slice(0, firstHunkIndex);
  const hunkLines = firstHunkIndex === -1 ? [] : lines.slice(firstHunkIndex);
  const hunks: DiffHunk[] = [];
  let current: string[] = [];
  for (const line of hunkLines) {
    if (line.startsWith("@@ ") && current.length) {
      hunks.push(toDiffHunk(current, hunks.length));
      current = [];
    }
    current.push(line);
  }
  if (current.length) hunks.push(toDiffHunk(current, hunks.length));
  return { path: filePath, headerLines, hunks, raw, isBinary };
}

function toDiffHunk(lines: string[], index: number): DiffHunk {
  const header = lines[0] ?? "";
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  return {
    index,
    header,
    oldStart: Number(match?.[1] ?? 0),
    oldLines: Number(match?.[2] ?? 1),
    newStart: Number(match?.[3] ?? 0),
    newLines: Number(match?.[4] ?? 1),
    content: lines.join("\n"),
  };
}

function validateHunkSelectors(commitIndex: number, changes: FileChange[], chunks: FileDiffChunk[]): string[] {
  const errors: string[] = [];
  const prefix = `Commit ${commitIndex + 1}`;
  for (const change of changes) {
    if (change.hunks.type === "indices") {
      const invalid = change.hunks.indices.filter((value) => !Number.isFinite(value) || Math.floor(value) !== value || value < 1);
      if (invalid.length) errors.push(`${prefix}: invalid hunk indices for ${change.path}`);
    }
    if (change.hunks.type === "lines") {
      const { start, end } = change.hunks;
      if (!Number.isFinite(start) || !Number.isFinite(end) || Math.floor(start) !== start || Math.floor(end) !== end || start < 1 || end < start) {
        errors.push(`${prefix}: invalid line range for ${change.path}`);
      }
    }
    const chunk = chunks.find((item) => item.path === change.path);
    if (!chunk || change.hunks.type === "all") continue;
    if (!selectHunks(chunk.hunks, change.hunks).length) errors.push(`${prefix}: No hunks selected for ${change.path}`);
  }
  return errors;
}

function parseCommitProposalInput(input: unknown): { value: CommitProposal } | { errors: string[] } {
  const record = objectRecord(input);
  if (!record) return { errors: ["proposal must be an object"] };
  const type = normalizeCommitType(record.type);
  if (!type) return { errors: ["type must be a conventional commit type"] };
  const summary = typeof record.summary === "string" ? record.summary : "";
  if (!summary.trim()) return { errors: ["summary is required"] };
  return {
    value: {
      type,
      scope: typeof record.scope === "string" && record.scope.trim() ? record.scope.trim() : null,
      summary,
      details: normalizeDetails(record.details),
      issueRefs: Array.isArray(record.issue_refs) ? record.issue_refs.filter((item): item is string => typeof item === "string") : [],
      warnings: [],
    },
  };
}

function parseSplitCommitInput(input: unknown): { value: { commits: SplitCommitGroup[] } } | { errors: string[] } {
  const record = objectRecord(input);
  if (!record || !Array.isArray(record.commits) || record.commits.length < 2) return { errors: ["split_commit requires at least two commits"] };
  const commits: SplitCommitGroup[] = [];
  const errors: string[] = [];
  for (let index = 0; index < record.commits.length; index++) {
    const item = objectRecord(record.commits[index]);
    if (!item) {
      errors.push(`Commit ${index + 1}: commit must be an object`);
      continue;
    }
    const type = normalizeCommitType(item.type);
    const summary = typeof item.summary === "string" ? item.summary : "";
    const changes = Array.isArray(item.changes) ? item.changes.map(parseFileChange).filter((change): change is FileChange => change !== undefined) : [];
    if (!type) errors.push(`Commit ${index + 1}: type must be a conventional commit type`);
    if (!summary.trim()) errors.push(`Commit ${index + 1}: summary is required`);
    if (!changes.length) errors.push(`Commit ${index + 1}: changes are required`);
    if (!type || !summary.trim() || !changes.length) continue;
    commits.push({
      type,
      scope: typeof item.scope === "string" && item.scope.trim() ? item.scope.trim() : null,
      summary,
      details: normalizeDetails(item.details),
      issueRefs: Array.isArray(item.issue_refs) ? item.issue_refs.filter((entry): entry is string => typeof entry === "string") : [],
      rationale: typeof item.rationale === "string" && item.rationale.trim() ? item.rationale.trim() : undefined,
      dependencies: Array.isArray(item.dependencies) ? item.dependencies.map(Number).filter(Number.isFinite).map(Math.floor) : [],
      changes,
    });
  }
  return errors.length ? { errors } : { value: { commits } };
}

function parseFileChange(input: unknown): FileChange | undefined {
  const record = objectRecord(input);
  if (!record || typeof record.path !== "string" || !record.path.trim()) return undefined;
  const hunks = objectRecord(record.hunks);
  if (!hunks || hunks.type === "all") return { path: record.path, hunks: { type: "all" } };
  if (hunks.type === "indices" && Array.isArray(hunks.indices)) {
    return { path: record.path, hunks: { type: "indices", indices: hunks.indices.map(Number).filter(Number.isFinite) } };
  }
  if (hunks.type === "lines") {
    return { path: record.path, hunks: { type: "lines", start: Number(hunks.start), end: Number(hunks.end) } };
  }
  return undefined;
}

function validateSummaryRules(summary: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (summary.length > SUMMARY_MAX_CHARS) errors.push(`Summary must be <= ${SUMMARY_MAX_CHARS} characters`);
  if (summary.endsWith(".")) errors.push("Summary must not end with a period");
  const normalizedFirst = (summary.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const hasPastTense = PAST_TENSE_VERBS.has(normalizedFirst) || (normalizedFirst.endsWith("ed") && !PAST_TENSE_ED_EXCEPTIONS.has(normalizedFirst));
  if (!hasPastTense) errors.push("Summary must start with a past-tense verb");
  const lower = summary.toLowerCase();
  for (const word of FILLER_WORDS) {
    if (lower.includes(word)) warnings.push(`Avoid filler word: ${word}`);
  }
  for (const phrase of META_PHRASES) {
    if (lower.includes(phrase)) warnings.push(`Avoid meta phrase: ${phrase}`);
  }
  return { errors, warnings };
}

function validateScope(scope: string | null): string[] {
  if (scope === null) return [];
  const errors: string[] = [];
  if (scope !== scope.toLowerCase()) errors.push("Scope must be lowercase");
  if (!/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)?$/.test(scope)) errors.push("Scope must contain only lowercase letters, digits, hyphens, underscores, and at most two slash-separated segments");
  return errors;
}

function validateTypeConsistency(type: CommitType, files: string[], options: { diffText?: string; summary?: string; details?: ConventionalDetail[] } = {}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lowerFiles = files.map((file) => file.toLowerCase());
  const hasDocs = lowerFiles.some((file) => /\.(md|mdx|adoc|rst)$/.test(file));
  const hasTests = lowerFiles.some((file) => /(^|\/)(test|tests|__tests__)(\/|$)/.test(file) || /(^|\/).*(_test|\.test|\.spec)\./.test(file));
  const hasCI = lowerFiles.some((file) => file.startsWith(".github/workflows/") || file.startsWith(".gitlab-ci"));
  const hasBuild = lowerFiles.some((file) => ["cargo.toml", "package.json", "makefile"].some((candidate) => file.endsWith(candidate)));
  const hasPerfEvidence = lowerFiles.some((file) => /(bench|benchmark|perf)/.test(file));
  const detailText = options.details?.map((detail) => detail.text.toLowerCase()).join(" ") ?? "";
  const hasPerfKeywords = /(performance|optimiz|latency|throughput|benchmark)/.test(`${options.summary?.toLowerCase() ?? ""} ${detailText}`);
  if (type === "docs" && !hasDocs) errors.push("Docs commit should include documentation file changes");
  if (type === "test" && !hasTests) errors.push("Test commit should include test file changes");
  if (type === "ci" && !hasCI) errors.push("CI commit should include CI configuration changes");
  if (type === "build" && !hasBuild) errors.push("Build commit should include build-related files");
  if (type === "refactor" && options.diffText && /\nnew file mode\s/m.test(options.diffText)) warnings.push("Refactor commit adds new files; consider feat if new functionality");
  if (type === "perf" && !hasPerfEvidence && !hasPerfKeywords) warnings.push("Perf commit lacks benchmark or performance keywords");
  return { errors, warnings };
}

function validateDependencies(commitIndex: number, dependencies: number[], totalCommits: number): string[] {
  const errors: string[] = [];
  const prefix = `Commit ${commitIndex + 1}`;
  for (const dependency of dependencies) {
    if (!Number.isFinite(dependency) || Math.floor(dependency) !== dependency) errors.push(`${prefix}: dependency index must be an integer`);
    else if (dependency === commitIndex) errors.push(`${prefix}: cannot depend on itself`);
    else if (dependency < 0 || dependency >= totalCommits) errors.push(`${prefix}: dependency index out of range (${dependency})`);
  }
  return errors;
}

function normalizeSummary(summary: string, type: CommitType, scope: string | null): string {
  const escapedScope = scope ? `\\(${escapeRegExp(scope)}\\)` : "(?:\\([^)]*\\))?";
  return summary
    .replace(/^[A-Z][A-Z0-9]+-\d+:\s*/, "")
    .replace(new RegExp(`^${type}${escapedScope}:\\s*`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDetails(input: unknown): ConventionalDetail[] {
  if (!Array.isArray(input)) return [];
  const details: Array<ConventionalDetail | undefined> = input.map((item) => {
    if (typeof item === "string") return { text: item, userVisible: true };
    const record = objectRecord(item);
    if (!record || typeof record.text !== "string") return undefined;
    return { text: record.text, userVisible: typeof record.userVisible === "boolean" ? record.userVisible : true };
  });
  return details.filter((item): item is ConventionalDetail => Boolean(item && item.text.trim()));
}

function capDetails(details: ConventionalDetail[]): { details: ConventionalDetail[]; warnings: string[] } {
  if (details.length <= MAX_DETAIL_ITEMS) return { details, warnings: [] };
  const scored = details.map((detail, index) => ({ detail, index, score: scoreDetail(detail.text) }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const keep = new Set(scored.slice(0, MAX_DETAIL_ITEMS).map((entry) => entry.index));
  return {
    details: details.filter((_detail, index) => keep.has(index)),
    warnings: [`Capped detail list to ${MAX_DETAIL_ITEMS} items based on priority scoring.`],
  };
}

function scoreDetail(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  if (/(security|vulnerability|exploit|cve)/.test(lower)) score += 100;
  if (/(breaking|incompatible)/.test(lower)) score += 90;
  if (/(performance|optimization|optimiz|latency|throughput)/.test(lower)) score += 80;
  if (/(bug|fix|crash|panic|regression|failure)/.test(lower)) score += 70;
  if (/(api|interface|public|export)/.test(lower)) score += 50;
  if (/(user|client|customer)/.test(lower)) score += 40;
  if (/(deprecated|removed|delete)/.test(lower)) score += 35;
  return score;
}

function parseNumstat(text: string): NumstatEntry[] {
  return text.split(/\r?\n/).map((line) => {
    const [additions, deletions, ...pathParts] = line.split(/\t/);
    const filePath = pathParts.join("\t");
    if (!filePath) return undefined;
    return {
      path: filePath,
      additions: additions === "-" ? 0 : Number(additions) || 0,
      deletions: deletions === "-" ? 0 : Number(deletions) || 0,
    };
  }).filter((entry): entry is NumstatEntry => entry !== undefined);
}

function extractScopeCandidates(numstat: NumstatEntry[]): string[] {
  const scores = new Map<string, number>();
  for (const entry of numstat) {
    const first = entry.path.split("/")[0] ?? "";
    if (!first) continue;
    scores.set(first, (scores.get(first) ?? 0) + entry.additions + entry.deletions);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([scope]) => scope.toLowerCase().replace(/[^a-z0-9_-]/g, "-"));
}

function filterExcludedFiles(files: string[]): { filtered: string[]; excluded: string[] } {
  const filtered: string[] = [];
  const excluded: string[] = [];
  for (const file of files) {
    if (isExcludedLockFile(file)) excluded.push(file);
    else filtered.push(file);
  }
  return { filtered, excluded };
}

function isExcludedLockFile(filePath: string): boolean {
  return LOCK_FILE_NAMES.has(filePath.split("/").pop() ?? filePath);
}

function normalizeCommitType(value: unknown): CommitType | undefined {
  return typeof value === "string" && COMMIT_TYPES.has(value) ? value as CommitType : undefined;
}

function objectRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

function truncateDiff(diff: string): string {
  const lines = diff.split("\n");
  if (lines.length <= 30) return diff;
  return [...lines.slice(0, 15), `\n... (truncated ${lines.length - 25} lines) ...\n`, ...lines.slice(-10)].join("\n");
}

function formatWarnings(warnings: string[]): string {
  return warnings.length ? `\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
}

function formatFileChangeSummary(change: FileChange): string {
  if (change.hunks.type === "all") return `${change.path} (all)`;
  if (change.hunks.type === "indices") return `${change.path} (hunks ${change.hunks.indices.join(", ")})`;
  return `${change.path} (lines ${change.hunks.start}-${change.hunks.end})`;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}
