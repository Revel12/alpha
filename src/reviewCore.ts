import { spawn } from "node:child_process";

export interface FileDiff {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  hunks: string;
}

export interface DiffStats {
  files: FileDiff[];
  totalAdded: number;
  totalRemoved: number;
  excluded: Array<{ path: string; reason: string; linesAdded: number; linesRemoved: number }>;
}

export interface CurrentReviewDiff {
  diffInstruction: string;
  diffText: string;
  emptyMessage?: string;
  mode: string;
}

export interface ReviewFindingDetails {
  title: string;
  body: string;
  priority: "P0" | "P1" | "P2" | "P3";
  confidence: number;
  file_path: string;
  line_start: number;
  line_end: number;
}

export interface ReviewFinding {
  title: string;
  body: string;
  priority: 0 | 1 | 2 | 3;
  confidence: number;
  file_path: string;
  line_start: number;
  line_end: number;
}

export interface ReviewYieldDetails {
  status?: "success" | "aborted";
  data?: unknown;
  error?: string;
}

const EXCLUDED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\.lock$/, reason: "lock file" },
  { pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
  { pattern: /package-lock\.json$/, reason: "lock file" },
  { pattern: /yarn\.lock$/, reason: "lock file" },
  { pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
  { pattern: /Cargo\.lock$/, reason: "lock file" },
  { pattern: /Gemfile\.lock$/, reason: "lock file" },
  { pattern: /poetry\.lock$/, reason: "lock file" },
  { pattern: /composer\.lock$/, reason: "lock file" },
  { pattern: /flake\.lock$/, reason: "lock file" },
  { pattern: /\.min\.(js|css)$/, reason: "minified" },
  { pattern: /\.generated\./, reason: "generated" },
  { pattern: /\.snap$/, reason: "snapshot" },
  { pattern: /\.map$/, reason: "source map" },
  { pattern: /^dist\//, reason: "build output" },
  { pattern: /^build\//, reason: "build output" },
  { pattern: /^out\//, reason: "build output" },
  { pattern: /node_modules\//, reason: "vendor" },
  { pattern: /vendor\//, reason: "vendor" },
  { pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
  { pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
  { pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

const MAX_DIFF_CHARS = 50_000;
const MAX_FILES_FOR_INLINE_DIFF = 20;
const DEFAULT_LARGE_DIFF_INSTRUCTION = "MUST run `git diff`/`git show` for assigned files";
const GIT_UNCOMMITTED_DIFF_INSTRUCTION =
  "MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files";
const JJ_UNCOMMITTED_DIFF_INSTRUCTION = "MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files";

export const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"] as const;

export function priorityOrdinal(priority: ReviewFindingDetails["priority"]): 0 | 1 | 2 | 3 {
  return PRIORITY_LABELS.indexOf(priority) as 0 | 1 | 2 | 3;
}

export function toReviewFinding(details: ReviewFindingDetails): ReviewFinding {
  return {
    title: details.title,
    body: details.body,
    priority: priorityOrdinal(details.priority),
    confidence: details.confidence,
    file_path: details.file_path,
    line_start: details.line_start,
    line_end: details.line_end,
  };
}

export function parseReportFindingDetails(value: unknown): ReviewFindingDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const priority = record.priority;
  const confidence = record.confidence;
  const lineStart = record.line_start;
  const lineEnd = record.line_end;
  if (typeof record.title !== "string" || typeof record.body !== "string") return undefined;
  if (!isPriority(priority)) return undefined;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined;
  if (typeof record.file_path !== "string" || !record.file_path.trim()) return undefined;
  if (typeof lineStart !== "number" || !Number.isFinite(lineStart)) return undefined;
  if (typeof lineEnd !== "number" || !Number.isFinite(lineEnd)) return undefined;
  return {
    title: record.title,
    body: record.body,
    priority,
    confidence,
    file_path: record.file_path,
    line_start: lineStart,
    line_end: lineEnd,
  };
}

export function parseReviewYieldDetails(value: unknown): ReviewYieldDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const status = record.status === "success" || record.status === "aborted" ? record.status : undefined;
  const error = typeof record.error === "string" ? record.error : undefined;
  return { status, data: record.data, error };
}

export function injectReviewFindings(data: unknown, findings: ReviewFinding[]): unknown {
  if (!findings.length || !data || typeof data !== "object" || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  if ("findings" in record) return data;
  if (looksLikeReviewVerdict(record)) return { ...record, findings };
  return data;
}

export function parseDiff(diffOutput: string): DiffStats {
  const files: FileDiff[] = [];
  const excluded: DiffStats["excluded"] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  const fileChunks = diffOutput.split(/^diff --git /m).filter(Boolean);
  for (const chunk of fileChunks) {
    const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;

    const filePath = headerMatch[2];
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
      if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
    }

    const exclusionReason = getExclusionReason(filePath);
    if (exclusionReason) {
      excluded.push({ path: filePath, reason: exclusionReason, linesAdded, linesRemoved });
      continue;
    }

    files.push({ path: filePath, linesAdded, linesRemoved, hunks: `diff --git ${chunk}` });
    totalAdded += linesAdded;
    totalRemoved += linesRemoved;
  }

  return { files, totalAdded, totalRemoved, excluded };
}

export function getRecommendedAgentCount(stats: DiffStats): number {
  const totalLines = stats.totalAdded + stats.totalRemoved;
  const fileCount = stats.files.length;
  if (totalLines < 100 || fileCount <= 2) return 1;
  if (totalLines < 500) return Math.min(2, fileCount);
  if (totalLines < 2000) return Math.min(4, Math.ceil(fileCount / 3));
  if (totalLines < 5000) return Math.min(8, Math.ceil(fileCount / 2));
  return Math.min(16, fileCount);
}

export function buildReviewPrompt(
  mode: string,
  stats: DiffStats,
  rawDiff: string,
  options: { additionalInstructions?: string; diffInstruction?: string } = {},
): string {
  const agentCount = getRecommendedAgentCount(stats);
  const skipDiff = rawDiff.length > MAX_DIFF_CHARS || stats.files.length > MAX_FILES_FOR_INLINE_DIFF;
  const totalLines = stats.totalAdded + stats.totalRemoved;
  const linesPerFile = skipDiff ? Math.max(5, Math.floor(100 / Math.max(1, stats.files.length))) : 0;

  return [
    "## Code Review Request",
    "",
    "### Mode",
    "",
    mode,
    "",
    `### Changed Files (${stats.files.length} files, +${stats.totalAdded}/-${stats.totalRemoved} lines)`,
    "",
    stats.files.length ? renderFileTable(stats.files) : "_No files to review._",
    stats.excluded.length ? ["", `### Excluded Files (${stats.excluded.length})`, "", ...stats.excluded.map((file) => `- \`${file.path}\` (+${file.linesAdded}/-${file.linesRemoved}) - ${file.reason}`)].join("\n") : undefined,
    "",
    "### Distribution Guidelines",
    "",
    'Use the `task` tool with `agent: "reviewer"` and a `tasks` array.',
    agentCount === 1 ? "Create exactly **1 reviewer task**." : `Spawn **${agentCount} reviewer agents** in parallel.`,
    agentCount > 1
      ? [
          "Group files by locality, e.g.:",
          "- Same directory/module -> same agent",
          "- Related functionality -> same agent",
          "- Tests with their implementation files -> same agent",
        ].join("\n")
      : undefined,
    "",
    "### Reviewer Instructions",
    "",
    "Reviewer MUST:",
    "1. Focus ONLY on assigned files",
    `2. ${skipDiff ? options.diffInstruction ?? DEFAULT_LARGE_DIFF_INSTRUCTION : "MUST use diff hunks below (NEVER re-run git diff)"}`,
    "3. MAY read full file context as needed via `read`",
    "4. Call `report_finding` per issue",
    "5. Call `yield` with verdict when done",
    "",
    skipDiff ? renderDiffPreviews(stats.files, linesPerFile) : ["### Diff", "", "<diff>", rawDiff.trim(), "</diff>"].join("\n"),
    options.additionalInstructions ? ["", "### Additional Instructions", "", options.additionalInstructions].join("\n") : undefined,
  ].filter((part): part is string => typeof part === "string").join("\n");
}

export function buildHeadlessReviewPrompt(focus?: string): string {
  return [
    "## Code Review Request",
    "",
    "### Mode",
    "",
    "Headless review request",
    "",
    "### Distribution Guidelines",
    "",
    'Use the `task` tool with `agent: "reviewer"` and a `tasks` array.',
    "Create exactly **1 reviewer task** for recent code changes.",
    focus ? ["", "### Focus", "", focus].join("\n") : undefined,
  ].filter((part): part is string => typeof part === "string").join("\n");
}

export async function buildUncommittedReviewPrompt(cwd = process.cwd(), additionalInstructions?: string): Promise<string> {
  const reviewDiff = await getUncommittedReviewDiff(cwd);
  if (!reviewDiff.diffText.trim()) return reviewDiff.emptyMessage ?? "No diff content found.";
  const stats = parseDiff(reviewDiff.diffText);
  if (!stats.files.length) return "No reviewable files (all changes filtered out).";
  return buildReviewPrompt(reviewDiff.mode, stats, reviewDiff.diffText, {
    additionalInstructions,
    diffInstruction: reviewDiff.diffInstruction,
  });
}

export async function buildBaseReviewPrompt(baseBranch: string, cwd = process.cwd(), additionalInstructions?: string): Promise<string> {
  const currentBranch = await getCurrentBranch(cwd);
  const diffText = await git(cwd, ["diff", `${baseBranch}...${currentBranch}`]);
  if (!diffText.trim()) return `No changes between ${baseBranch} and ${currentBranch}.`;
  const stats = parseDiff(diffText);
  if (!stats.files.length) return "No reviewable files (all changes filtered out).";
  return buildReviewPrompt(`Reviewing changes between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`, stats, diffText, {
    additionalInstructions,
  });
}

export async function buildCommitReviewPrompt(commit: string, cwd = process.cwd(), additionalInstructions?: string): Promise<string> {
  const diffText = await git(cwd, ["show", "--format=", commit]);
  if (!diffText.trim()) return "Commit has no diff content.";
  const stats = parseDiff(diffText);
  if (!stats.files.length) return "No reviewable files in commit (all changes filtered out).";
  return buildReviewPrompt(`Reviewing commit \`${commit}\``, stats, diffText, { additionalInstructions });
}

export async function buildInteractiveReviewPrompt(args: string, cwd = process.cwd()): Promise<string | undefined> {
  const parsed = parseReviewCommandArgs(args);
  if (parsed.mode === "uncommitted") return buildUncommittedReviewPrompt(cwd, parsed.instructions);
  if (parsed.mode === "base") return buildBaseReviewPrompt(parsed.target, cwd, parsed.instructions);
  if (parsed.mode === "commit") return buildCommitReviewPrompt(parsed.target, cwd, parsed.instructions);
  if (parsed.mode === "custom") return parsed.instructions ? buildCustomReviewPrompt(parsed.instructions) : undefined;

  const vscode = await import("vscode");
  const picked = await vscode.window.showQuickPick(
    ["Review against a base branch (PR Style)", "Review uncommitted changes", "Review a specific commit", "Custom review instructions"],
    { title: "Review Mode" },
  );
  if (!picked) return undefined;
  if (picked.startsWith("Review uncommitted")) return buildUncommittedReviewPrompt(cwd);
  if (picked.startsWith("Review against")) {
    const branches = await getGitBranches(cwd);
    const base = await vscode.window.showQuickPick(branches, { title: "Select base branch to compare against" });
    return base ? buildBaseReviewPrompt(base, cwd) : undefined;
  }
  if (picked.startsWith("Review a specific")) {
    const commits = await getRecentCommits(cwd, 20);
    const selected = await vscode.window.showQuickPick(commits, { title: "Select commit to review" });
    return selected ? buildCommitReviewPrompt(selected.split(" ")[0], cwd) : undefined;
  }
  const instructions = await vscode.window.showInputBox({
    title: "Custom review instructions",
    prompt: "Enter custom review instructions.",
    value: "Review the following:",
  });
  if (!instructions?.trim()) return undefined;
  try {
    return await buildUncommittedReviewPrompt(cwd, instructions);
  } catch {
    return buildCustomReviewPrompt(instructions);
  }
}

function buildCustomReviewPrompt(instructions: string): string {
  return [
    "## Code Review Request",
    "",
    "### Mode",
    "",
    "Custom review instructions",
    "",
    "### Distribution Guidelines",
    "",
    'Use the `task` tool with `agent: "reviewer"` and a `tasks` array.',
    "Create exactly **1 reviewer task**. Its assignment MUST include the custom instructions below.",
    "",
    "### Reviewer Instructions",
    "",
    "Reviewer MUST:",
    "1. Follow the custom instructions below",
    "2. Read the referenced files or workspace context needed to evaluate them",
    "3. Call `report_finding` per issue",
    "4. Call `yield` with verdict when done",
    "",
    "### Custom Instructions",
    "",
    instructions,
  ].join("\n");
}

async function getUncommittedReviewDiff(cwd: string): Promise<CurrentReviewDiff> {
  if (await isJjRepo(cwd)) {
    return {
      diffText: await jj(cwd, ["--ignore-working-copy", "diff", "--git"]),
      diffInstruction: JJ_UNCOMMITTED_DIFF_INSTRUCTION,
      emptyMessage: "No uncommitted changes found",
      mode: "Reviewing JJ working-copy changes",
    };
  }

  const status = await git(cwd, ["status", "--porcelain"]);
  if (!status.trim()) {
    return {
      diffText: "",
      diffInstruction: GIT_UNCOMMITTED_DIFF_INSTRUCTION,
      emptyMessage: "No uncommitted changes found",
      mode: "Reviewing uncommitted changes (staged + unstaged)",
    };
  }

  const [unstagedDiff, stagedDiff] = await Promise.all([git(cwd, ["diff"]), git(cwd, ["diff", "--cached"])]);
  return {
    diffText: [unstagedDiff, stagedDiff].filter(Boolean).join("\n"),
    diffInstruction: GIT_UNCOMMITTED_DIFF_INSTRUCTION,
    emptyMessage: "No diff content found",
    mode: "Reviewing uncommitted changes (staged + unstaged)",
  };
}

async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "HEAD";
  } catch {
    return "HEAD";
  }
}

async function getGitBranches(cwd: string): Promise<string[]> {
  try {
    return (await git(cwd, ["branch", "--all", "--format=%(refname:short)"]))
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^origin\//, ""))
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
  } catch {
    return [];
  }
}

async function getRecentCommits(cwd: string, count: number): Promise<string[]> {
  try {
    return (await git(cwd, ["log", "--oneline", "-n", String(count)])).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function isJjRepo(cwd: string): Promise<boolean> {
  try {
    await jj(cwd, ["root"]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return runCommand(cwd, "git", args);
}

async function jj(cwd: string, args: string[]): Promise<string> {
  return runCommand(cwd, "jj", args);
}

function runCommand(cwd: string, command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited ${code}`));
      }
    });
  });
}

function parseReviewCommandArgs(args: string):
  | { mode: "interactive" }
  | { mode: "uncommitted"; instructions?: string }
  | { mode: "base"; target: string; instructions?: string }
  | { mode: "commit"; target: string; instructions?: string }
  | { mode: "custom"; instructions: string } {
  const trimmed = args.trim();
  if (!trimmed) return { mode: "interactive" };
  const tokens = trimmed.split(/\s+/);
  const mode = tokens[0]?.toLowerCase();
  if (mode === "uncommitted" || mode === "working" || mode === "diff") {
    return { mode: "uncommitted", instructions: tokens.slice(1).join(" ") || undefined };
  }
  if (mode === "base" || mode === "branch" || mode === "pr") {
    const target = tokens[1];
    if (!target) return { mode: "interactive" };
    return { mode: "base", target, instructions: tokens.slice(2).join(" ") || undefined };
  }
  if (mode === "commit" || mode === "show") {
    const target = tokens[1];
    if (!target) return { mode: "interactive" };
    return { mode: "commit", target, instructions: tokens.slice(2).join(" ") || undefined };
  }
  return { mode: "custom", instructions: trimmed };
}

function renderFileTable(files: FileDiff[]): string {
  return [
    "| File | +/- | Type |",
    "|---|---:|---|",
    ...files.map((file) => `| ${file.path} | +${file.linesAdded}/-${file.linesRemoved} | ${getFileExt(file.path)} |`),
  ].join("\n");
}

function renderDiffPreviews(files: FileDiff[], linesPerFile: number): string {
  return [
    "### Diff Previews",
    "",
    `_Full diff too large (${files.length} files). Showing first ~${linesPerFile} lines per file._`,
    "",
    ...files.map((file) => [`#### ${file.path}`, "", "```diff", getDiffPreview(file.hunks, linesPerFile), "```"].join("\n")),
  ].join("\n\n");
}

function getDiffPreview(hunks: string, maxLines: number): string {
  const contentLines: string[] = [];
  for (const line of hunks.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) {
      continue;
    }
    contentLines.push(line);
    if (contentLines.length >= maxLines) break;
  }
  return contentLines.join("\n");
}

function getFileExt(filePath: string): string {
  const match = filePath.match(/\.([^.]+)$/);
  return match ? match[1] : "";
}

function getExclusionReason(filePath: string): string | undefined {
  for (const { pattern, reason } of EXCLUDED_PATTERNS) {
    if (pattern.test(filePath)) return reason;
  }
  return undefined;
}

function isPriority(value: unknown): value is ReviewFindingDetails["priority"] {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function looksLikeReviewVerdict(record: Record<string, unknown>): boolean {
  return (
    (record.overall_correctness === "correct" || record.overall_correctness === "incorrect") &&
    typeof record.explanation === "string" &&
    typeof record.confidence === "number"
  );
}
