export type ToolTier = "read" | "write" | "exec";
export type ApprovalPolicy = "allow" | "deny" | "prompt";
export type ApprovalMode = "always-ask" | "write" | "yolo";

export interface ToolApprovalDecisionObject {
  tier: ToolTier;
  override?: boolean;
  reason?: string;
}

export type ToolApprovalDecision = ToolTier | ToolApprovalDecisionObject;

export interface ApprovalSubject {
  name: string;
  approval?: ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);
  formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
}

export interface ResolvedApproval {
  policy: ApprovalPolicy;
  tier: ToolTier;
  reason?: string;
  override: boolean;
}

const POLICY_VALUES: ReadonlySet<ApprovalPolicy> = new Set(["allow", "deny", "prompt"]);
const TIER_VALUES: ReadonlySet<ToolTier> = new Set(["read", "write", "exec"]);

const TIER_RANK: Record<ToolTier, number> = {
  read: 0,
  write: 1,
  exec: 2,
};

const APPROVAL_MODE_MAX_TIER: Record<ApprovalMode, ToolTier> = {
  "always-ask": "read",
  write: "write",
  yolo: "exec",
};

export const CRITICAL_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*[rRfF][a-z]*\s+\//i,
  /\bsudo\s+rm\b/i,
  /\bchmod\s+-R\s+[0-7]+\s+\//i,
  /\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//,
  /\bchown\s+-R\s+\S+\s+\//i,
  /:\(\)\s*\{\s*:\s*\|\s*:/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bmkfs(\.|\b)/i,
  /\bdd\s+if=.+of=\/dev\//i,
  /\bshred\s+\/dev\//i,
  /\bcryptsetup\b/i,
  />\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
  /\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i,
  /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
  /(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
  /\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,
  /\bkill\s+-9\s+1\b/,
  /(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
  /(?:^|[\s;&|(])init\s+0\b/i,
  /\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i,
];

export const LSP_READONLY_ACTIONS: ReadonlySet<string> = new Set([
  "diagnostics",
  "definition",
  "type_definition",
  "implementation",
  "references",
  "hover",
  "symbols",
  "status",
  "capabilities",
]);

export const BITBUCKET_READONLY_OPS: ReadonlySet<string> = new Set([
  "repo_view",
  "pr_view",
  "search_prs",
  "search_repos",
  "search_code",
  "search_commits",
  "run_watch",
]);

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === "always-ask" || value === "write" || value === "yolo" ? value : "yolo";
}

export function resolveApproval(
  tool: ApprovalSubject,
  args: unknown,
  mode: ApprovalMode,
  userConfig: Record<string, unknown> = {},
): ResolvedApproval {
  const decision = getToolDecision(tool, args);
  const userPolicy = Object.hasOwn(userConfig, tool.name) ? normalizePolicy(userConfig[tool.name]) : undefined;

  if (mode === "yolo") {
    return { policy: userPolicy ?? "allow", tier: decision.tier, override: false };
  }

  if (decision.override) {
    if (userPolicy === "deny") {
      return { policy: "deny", tier: decision.tier, override: true };
    }
    return {
      policy: "prompt",
      tier: decision.tier,
      override: true,
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  }

  if (userPolicy) {
    return { policy: userPolicy, tier: decision.tier, override: false };
  }

  if (modeApprovesTier(mode, decision.tier)) {
    return { policy: "allow", tier: decision.tier, override: false };
  }

  return {
    policy: "prompt",
    tier: decision.tier,
    override: false,
    ...(decision.reason ? { reason: decision.reason } : {}),
  };
}

export function formatApprovalPrompt(tool: ApprovalSubject, args: unknown, reason?: string): string {
  const lines = [`Allow tool: ${tool.name}`];
  if (reason) lines.push(`Reason: ${reason}`);
  const details = tool.formatApprovalDetails?.(args);
  if (typeof details === "string") {
    if (details.length > 0) lines.push(details);
  } else if (Array.isArray(details)) {
    for (const detail of details) {
      if (detail.length > 0) lines.push(detail);
    }
  }
  return lines.join("\n");
}

export function truncateForPrompt(value: string, maxChars = 2000): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}... (${omitted} chars truncated)`;
}

export function bashApproval(args: unknown): ToolApprovalDecision {
  const command = getStringProperty(args, "command") ?? "";
  if (command !== "" && CRITICAL_BASH_PATTERNS.some((pattern) => pattern.test(command))) {
    return { tier: "exec", override: true, reason: "Critical pattern detected" };
  }
  return "exec";
}

export function bashApprovalDetails(args: unknown): string[] {
  return [`Command: ${truncateForPrompt(getStringProperty(args, "command") ?? "(missing)")}`];
}

export function taskApproval(_args: unknown): ToolApprovalDecision {
  return "exec";
}

export function taskApprovalDetails(args: unknown): string[] {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const lines: string[] = [];
  if (typeof input.agent === "string") lines.push(`Agent: ${truncateForPrompt(input.agent)}`);
  if (typeof input.id === "string" && input.id.trim()) lines.push(`Task: ${truncateForPrompt(input.id)}`);
  if (typeof input.assignment === "string") lines.push(`Assignment:\n${truncateForPrompt(input.assignment)}`);
  if (typeof input.context === "string" && input.context.trim()) lines.push(`Context:\n${truncateForPrompt(input.context)}`);
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const first = tasks[0];
  if (first && typeof first === "object") {
    const item = first as Record<string, unknown>;
    if (typeof item.id === "string" && item.id.trim()) lines.push(`Task: ${truncateForPrompt(item.id)}`);
    if (typeof item.assignment === "string") lines.push(`Assignment:\n${truncateForPrompt(item.assignment)}`);
    if (tasks.length > 1) lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
  }
  return lines;
}

export function evalApproval(_args: unknown): ToolApprovalDecision {
  return "exec";
}

export function evalApprovalDetails(args: unknown): string[] {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const cells = Array.isArray(input.cells) ? input.cells : [];
  const first = cells[0] && typeof cells[0] === "object" ? cells[0] as Record<string, unknown> : undefined;
  if (!first) return [];
  const language = typeof first.language === "string" ? first.language : "(missing)";
  const code = typeof first.code === "string" ? first.code : "";
  const lines = [`Language: ${language}`, `Code:\n${truncateForPrompt(code)}`];
  if (cells.length > 1) lines.push(`+${cells.length - 1} more cell${cells.length === 2 ? "" : "s"}`);
  return lines;
}

export function editApproval(args: unknown): ToolApprovalDecision {
  const targetPath = extractEditApprovalPath(args);
  return targetPath !== "(unknown)" && isInternalUrlPath(targetPath) ? "read" : "write";
}

export function editApprovalDetails(args: unknown): string[] {
  return [`File: ${truncateForPrompt(extractEditApprovalPath(args))}`];
}

export function writeApproval(args: unknown): ToolApprovalDecision {
  const rawPath = getStringProperty(args, "path");
  return rawPath && isInternalUrlPath(rawPath) ? "read" : "write";
}

export function writeApprovalDetails(args: unknown): string[] {
  const targetPath = getStringProperty(args, "path") ?? "(missing)";
  const content = getStringProperty(args, "content") ?? "";
  return [`Path: ${truncateForPrompt(targetPath)}`, `Content:\n${truncateForPrompt(content)}`];
}

export function sshApproval(): ToolApprovalDecision {
  return "exec";
}

export function browserApproval(): ToolApprovalDecision {
  return "exec";
}

export function bitbucketApproval(args: unknown): ToolApprovalDecision {
  const op = (getStringProperty(args, "op") ?? "").toLowerCase();
  return BITBUCKET_READONLY_OPS.has(op) ? "read" : "exec";
}

export function bitbucketApprovalDetails(args: unknown): string[] {
  const op = getStringProperty(args, "op") ?? "(missing)";
  const repo = getStringProperty(args, "repo");
  const pr = getStringProperty(args, "pr");
  const title = getStringProperty(args, "title");
  const lines = [`Op: ${truncateForPrompt(op)}`];
  if (repo) lines.push(`Repo: ${truncateForPrompt(repo)}`);
  if (pr) lines.push(`PR: ${truncateForPrompt(pr)}`);
  if (title) lines.push(`Title: ${truncateForPrompt(title)}`);
  return lines;
}

export function lspApproval(args: unknown): ToolApprovalDecision {
  const action = (getStringProperty(args, "action") ?? "").toLowerCase();
  return LSP_READONLY_ACTIONS.has(action) ? "read" : "write";
}

export function lspApprovalDetails(args: unknown): string[] {
  const action = getStringProperty(args, "action") ?? "(missing)";
  const file = getStringProperty(args, "file");
  const lines = [`Action: ${truncateForPrompt(action)}`];
  if (file) lines.push(`File: ${truncateForPrompt(file)}`);
  return lines;
}

export function modeApprovesTier(mode: ApprovalMode, tier: ToolTier): boolean {
  return TIER_RANK[tier] <= TIER_RANK[APPROVAL_MODE_MAX_TIER[mode]];
}

function normalizePolicy(value: unknown): ApprovalPolicy | undefined {
  if (typeof value !== "string") return undefined;
  const lowered = value.trim().toLowerCase();
  return POLICY_VALUES.has(lowered as ApprovalPolicy) ? (lowered as ApprovalPolicy) : undefined;
}

function getToolDecision(tool: ApprovalSubject, args: unknown): Omit<ResolvedApproval, "policy"> {
  const approval = tool.approval;
  const decision = typeof approval === "function" ? approval(args) : approval;
  return normalizeDecision(decision);
}

function normalizeDecision(value: unknown): Omit<ResolvedApproval, "policy"> {
  if (isToolTier(value)) {
    return { tier: value, override: false };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const tier = isToolTier(record.tier) ? record.tier : "exec";
    const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : undefined;
    return {
      tier,
      override: record.override === true,
      ...(reason ? { reason } : {}),
    };
  }

  return { tier: "exec", override: false };
}

function isToolTier(value: unknown): value is ToolTier {
  return typeof value === "string" && TIER_VALUES.has(value as ToolTier);
}

function extractEditApprovalPath(args: unknown): string {
  const input = getStringProperty(args, "input");
  if (input) {
    const hashlineMatch = /^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/m.exec(input);
    if (hashlineMatch?.[1]) return hashlineMatch[1];

    const applyPatchMatch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(input);
    if (applyPatchMatch?.[1]) return applyPatchMatch[1].trim();
  }

  return getStringProperty(args, "path") ?? "(unknown)";
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function isInternalUrlPath(filePath: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(filePath.trim());
}
