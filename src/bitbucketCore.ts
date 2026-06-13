export type BitbucketOp =
  | "repo_view"
  | "pr_view"
  | "pr_create"
  | "pr_checkout"
  | "pr_push"
  | "pr_comment"
  | "pr_approve"
  | "pr_unapprove"
  | "pr_decline"
  | "pr_merge"
  | "search_prs"
  | "search_repos"
  | "search_code"
  | "search_commits"
  | "run_watch";

export interface BitbucketInput {
  op: BitbucketOp;
  repo?: string;
  baseUrl?: string;
  project?: string;
  workspace?: string;
  slug?: string;
  pr?: number | string | string[];
  force?: boolean;
  title?: string;
  body?: string;
  fill?: boolean;
  draft?: boolean;
  sourceBranch?: string;
  targetBranch?: string;
  branch?: string;
  query?: string;
  since?: string;
  until?: string;
  dateField: "created" | "updated";
  limit: number;
  state?: string;
  comment?: string;
  reviewer?: string[];
  assignee?: string[];
  label?: string[];
  closeSourceBranch?: boolean;
  forceWithLease?: boolean;
  run?: string;
  tail: number;
}

export interface BitbucketRepoRef {
  kind: "server" | "cloud";
  baseUrl: string;
  projectOrWorkspace: string;
  slug: string;
}

export interface BitbucketAuthConfig {
  authHeader?: string;
  token?: string;
  username?: string;
  password?: string;
}

export const BITBUCKET_OPS: readonly BitbucketOp[] = [
  "repo_view",
  "pr_view",
  "pr_create",
  "pr_checkout",
  "pr_push",
  "pr_comment",
  "pr_approve",
  "pr_unapprove",
  "pr_decline",
  "pr_merge",
  "search_prs",
  "search_repos",
  "search_code",
  "search_commits",
  "run_watch",
] as const;

export const BITBUCKET_READONLY_OPS: ReadonlySet<string> = new Set([
  "repo_view",
  "pr_view",
  "search_prs",
  "search_repos",
  "search_code",
  "search_commits",
  "run_watch",
]);

const BITBUCKET_OP_SET = new Set<string>(BITBUCKET_OPS);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_TAIL = 80;
const MAX_TAIL = 500;
const RELATIVE_DURATION_PATTERN = /^(\d+)\s*(m|h|d|w|mo|y)$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FIXED_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

export function parseBitbucketInput(args: string): BitbucketInput {
  const trimmed = args.trim();
  if (!trimmed) throw new Error("bitbucket requires JSON input with an op.");
  const raw = trimmed.startsWith("{") ? JSON.parse(trimmed) as Record<string, unknown> : { op: "repo_view", repo: trimmed };
  const op = normalizeString(raw.op);
  if (!op || !BITBUCKET_OP_SET.has(op)) throw new Error(`Unsupported bitbucket op: ${op || "(missing)"}`);
  return {
    op: op as BitbucketOp,
    repo: normalizeString(raw.repo),
    baseUrl: normalizeString(raw.baseUrl),
    project: normalizeString(raw.project),
    workspace: normalizeString(raw.workspace),
    slug: normalizeString(raw.slug),
    pr: normalizePr(raw.pr),
    force: typeof raw.force === "boolean" ? raw.force : undefined,
    title: normalizeString(raw.title),
    body: normalizeString(raw.body),
    fill: typeof raw.fill === "boolean" ? raw.fill : undefined,
    draft: typeof raw.draft === "boolean" ? raw.draft : undefined,
    sourceBranch: normalizeString(raw.sourceBranch) ?? normalizeString(raw.head),
    targetBranch: normalizeString(raw.targetBranch) ?? normalizeString(raw.base),
    branch: normalizeString(raw.branch),
    query: normalizeString(raw.query),
    since: normalizeString(raw.since),
    until: normalizeString(raw.until),
    dateField: raw.dateField === "updated" ? "updated" : "created",
    limit: clampInteger(raw.limit, DEFAULT_LIMIT, MAX_LIMIT),
    state: normalizeString(raw.state),
    comment: normalizeString(raw.comment) ?? normalizeString(raw.message),
    reviewer: normalizeStringArray(raw.reviewer),
    assignee: normalizeStringArray(raw.assignee),
    label: normalizeStringArray(raw.label),
    closeSourceBranch: typeof raw.closeSourceBranch === "boolean" ? raw.closeSourceBranch : undefined,
    forceWithLease: typeof raw.forceWithLease === "boolean" ? raw.forceWithLease : undefined,
    run: normalizeString(raw.run),
    tail: clampInteger(raw.tail, DEFAULT_TAIL, MAX_TAIL),
  };
}

export function bitbucketApprovalDetails(input: Partial<BitbucketInput>): string[] {
  const lines = [`Op: ${input.op ?? "(missing)"}`];
  if (input.repo) lines.push(`Repo: ${input.repo}`);
  if (input.pr !== undefined) lines.push(`PR: ${input.pr}`);
  if (input.title) lines.push(`Title: ${input.title}`);
  if (input.sourceBranch) lines.push(`Source: ${input.sourceBranch}`);
  if (input.targetBranch) lines.push(`Target: ${input.targetBranch}`);
  return lines;
}

export function resolveBitbucketAuth(config: BitbucketAuthConfig): string | undefined {
  if (config.authHeader?.trim()) return config.authHeader.trim();
  if (config.username && (config.password || config.token)) {
    return `Basic ${Buffer.from(`${config.username}:${config.password ?? config.token}`, "utf8").toString("base64")}`;
  }
  if (!config.token) return undefined;
  const token = config.token.trim();
  if (/^(?:Bearer|Basic)\s+/i.test(token)) return token;
  return `Bearer ${token}`;
}

export function parseBitbucketRemoteUrl(remote: string | undefined, fallbackBaseUrl?: string): BitbucketRepoRef | undefined {
  const value = remote?.trim();
  if (!value) return undefined;

  const normalizedFallback = fallbackBaseUrl ? normalizeBaseUrl(fallbackBaseUrl) : undefined;
  const https = parseHttpsRemote(value, normalizedFallback);
  if (https) return https;
  const ssh = parseSshRemote(value, normalizedFallback);
  if (ssh) return ssh;
  return parseScpLikeRemote(value, normalizedFallback);
}

export function resolveBitbucketRepo(input: Pick<BitbucketInput, "repo" | "baseUrl" | "project" | "workspace" | "slug">, remote?: string, configuredBaseUrl?: string): BitbucketRepoRef {
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? configuredBaseUrl ?? parseBitbucketRemoteUrl(remote)?.baseUrl ?? "https://bitbucket.org");
  const kind = isCloudBaseUrl(baseUrl) ? "cloud" : "server";
  const explicitNamespace = input.project ?? input.workspace;
  if (explicitNamespace && input.slug) {
    return { kind, baseUrl, projectOrWorkspace: explicitNamespace, slug: stripGitSuffix(input.slug) };
  }

  if (input.repo) {
    const parsedUrl = parseBitbucketRemoteUrl(input.repo, baseUrl);
    if (parsedUrl) return parsedUrl;
    const [namespace, slug] = splitRepo(input.repo);
    if (namespace && slug) return { kind, baseUrl, projectOrWorkspace: namespace, slug };
  }

  const parsedRemote = parseBitbucketRemoteUrl(remote, baseUrl);
  if (parsedRemote) return { ...parsedRemote, kind, baseUrl: input.baseUrl || configuredBaseUrl ? baseUrl : parsedRemote.baseUrl };
  throw new Error("Could not infer Bitbucket repo. Pass repo as PROJECT/repo or configure/open a Bitbucket git remote.");
}

export function bitbucketApiUrl(repo: BitbucketRepoRef, path: string, query: Record<string, string | number | boolean | undefined> = {}): string {
  const url = repo.kind === "cloud"
    ? new URL(`/2.0/repositories/${encodeURIComponent(repo.projectOrWorkspace)}/${encodeURIComponent(repo.slug)}${path}`, "https://api.bitbucket.org")
    : new URL(`/rest/api/1.0/projects/${encodeURIComponent(repo.projectOrWorkspace)}/repos/${encodeURIComponent(repo.slug)}${path}`, repo.baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function bitbucketSearchReposUrl(repo: BitbucketRepoRef, query: string | undefined, limit: number): string {
  if (repo.kind === "cloud") {
    const url = new URL("/2.0/repositories", "https://api.bitbucket.org");
    if (query) url.searchParams.set("q", `name ~ "${escapeCloudQuery(query)}"`);
    url.searchParams.set("pagelen", String(limit));
    return url.toString();
  }
  const url = new URL("/rest/api/1.0/repos", repo.baseUrl);
  if (query) url.searchParams.set("name", query);
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

export function bitbucketPrPayload(repo: BitbucketRepoRef, input: BitbucketInput): object {
  if (!input.title) throw new Error("bitbucket pr_create requires title, or fill=true with local git commit data available.");
  const sourceBranch = input.sourceBranch ?? input.branch;
  if (!sourceBranch) throw new Error("bitbucket pr_create requires sourceBranch.");
  const targetBranch = input.targetBranch ?? "main";

  if (repo.kind === "cloud") {
    return {
      title: input.title,
      description: input.body ?? "",
      source: { branch: { name: sourceBranch } },
      destination: { branch: { name: targetBranch } },
      ...(input.closeSourceBranch !== undefined ? { close_source_branch: input.closeSourceBranch } : {}),
      ...(input.reviewer?.length ? { reviewers: input.reviewer.map((uuid) => ({ uuid })) } : {}),
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
    };
  }

  return {
    title: input.title,
    description: input.body ?? "",
    fromRef: {
      id: `refs/heads/${sourceBranch}`,
      repository: serverRepositoryPayload(repo),
    },
    toRef: {
      id: `refs/heads/${targetBranch}`,
      repository: serverRepositoryPayload(repo),
    },
    ...(input.reviewer?.length ? { reviewers: input.reviewer.map((name) => ({ user: { name } })) } : {}),
    ...(input.draft !== undefined ? { draft: input.draft } : {}),
  };
}

export function prNumber(input: BitbucketInput): number {
  const raw = Array.isArray(input.pr) ? input.pr[0] : input.pr;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/^#/, "")) : NaN;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`bitbucket ${input.op} requires a positive pr number.`);
  return value;
}

export function prIdentifiers(input: BitbucketInput): string[] {
  if (input.pr === undefined) return [];
  const raw = Array.isArray(input.pr) ? input.pr : [input.pr];
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

export function parseBitbucketPrUrl(value: string | undefined): { repo?: string; pr?: number } {
  if (!value) return {};
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {};
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const pullIndex = parts.findIndex((part) => part === "pull-requests" || part === "pullrequests" || part === "pull");
  if (pullIndex < 0 || !parts[pullIndex + 1]) return {};
  const pr = Number(parts[pullIndex + 1]);
  if (!Number.isInteger(pr) || pr <= 0) return {};
  if (parts[0] === "projects" && parts[2] === "repos" && parts[1] && parts[3]) {
    return { repo: `${parts[1]}/${parts[3]}`, pr };
  }
  if (parts[0] && parts[1]) return { repo: `${parts[0]}/${parts[1]}`, pr };
  return { pr };
}

export function bitbucketPrDiffUrl(repo: BitbucketRepoRef, pr: number): string {
  return repo.kind === "cloud"
    ? bitbucketApiUrl(repo, `/pullrequests/${pr}/diff`)
    : bitbucketApiUrl(repo, `/pull-requests/${pr}.diff`);
}

export function bitbucketCommitsUrl(repo: BitbucketRepoRef, branch: string | undefined, limit: number): string {
  if (repo.kind === "cloud") {
    return bitbucketApiUrl(repo, branch ? `/commits/${encodeURIComponent(branch)}` : "/commits", { pagelen: limit });
  }
  return bitbucketApiUrl(repo, "/commits", { until: branch, limit });
}

export function formatBitbucketRepo(repo: BitbucketRepoRef, data: unknown): string {
  const value = asRecord(data);
  const lines = [`# ${repo.projectOrWorkspace}/${repo.slug}`];
  push(lines, "Host", repo.kind === "cloud" ? "Bitbucket Cloud" : repo.baseUrl);
  push(lines, "Name", stringField(value, "name") ?? stringField(value, "slug"));
  push(lines, "Description", stringField(value, "description"));
  push(lines, "Default branch", nestedString(value, ["mainbranch", "name"]) ?? nestedString(value, ["mainBranch", "displayId"]));
  push(lines, "Public", booleanField(value, "is_private") === undefined ? undefined : String(!booleanField(value, "is_private")));
  push(lines, "State", stringField(value, "state"));
  push(lines, "URL", nestedString(value, ["links", "html", "href"]) ?? nestedString(value, ["links", "self", 0, "href"]));
  return lines.join("\n");
}

export function formatBitbucketPr(repo: BitbucketRepoRef, data: unknown): string {
  const value = asRecord(data);
  const number = numberField(value, "id") ?? numberField(value, "number");
  const title = stringField(value, "title") ?? "(untitled)";
  const lines = [`# PR ${number ?? "?"}: ${title}`];
  push(lines, "Repo", `${repo.projectOrWorkspace}/${repo.slug}`);
  push(lines, "State", stringField(value, "state"));
  push(lines, "Author", nestedString(value, ["author", "display_name"]) ?? nestedString(value, ["author", "user", "displayName"]));
  push(lines, "Source", nestedString(value, ["source", "branch", "name"]) ?? nestedString(value, ["fromRef", "displayId"]));
  push(lines, "Target", nestedString(value, ["destination", "branch", "name"]) ?? nestedString(value, ["toRef", "displayId"]));
  push(lines, "Updated", stringField(value, "updated_on") ?? stringField(value, "updatedDate"));
  push(lines, "URL", nestedString(value, ["links", "html", "href"]) ?? nestedString(value, ["links", "self", 0, "href"]));
  const description = stringField(value, "description");
  if (description) lines.push("", description.trim());
  return lines.join("\n");
}

export function formatBitbucketList(title: string, data: unknown, limit: number): string {
  const values = arrayField(asRecord(data), "values").slice(0, limit);
  if (values.length === 0) return `${title}: no results.`;
  const lines = [`${title}: ${values.length} result${values.length === 1 ? "" : "s"}`];
  for (const item of values) {
    const row = asRecord(item);
    const id = numberField(row, "id") ?? numberField(row, "number");
    const name = stringField(row, "title") ?? stringField(row, "name") ?? stringField(row, "slug") ?? "(unnamed)";
    const state = stringField(row, "state");
    const href = nestedString(row, ["links", "html", "href"]) ?? nestedString(row, ["links", "self", 0, "href"]);
    lines.push(`- ${id ? `#${id} ` : ""}${name}${state ? ` [${state}]` : ""}${href ? ` ${href}` : ""}`);
  }
  return lines.join("\n");
}

export function applyBitbucketDateFilter(values: unknown[], input: Pick<BitbucketInput, "since" | "until" | "dateField">, now = new Date()): unknown[] {
  if (!input.since && !input.until) return values;
  const sinceMs = input.since ? Date.parse(parseSearchDateBound(input.since, now)) : undefined;
  const untilMs = input.until ? Date.parse(parseSearchDateBound(input.until, now)) : undefined;
  return values.filter((item) => {
    const row = asRecord(item);
    const dateValue = input.dateField === "updated"
      ? stringField(row, "updated_on") ?? stringField(row, "updatedDate") ?? stringField(row, "date")
      : stringField(row, "created_on") ?? stringField(row, "createdDate") ?? stringField(row, "date") ?? stringField(row, "authorTimestamp");
    const ms = dateValue ? Date.parse(dateValue) : NaN;
    if (Number.isNaN(ms)) return true;
    if (sinceMs !== undefined && ms < sinceMs) return false;
    if (untilMs !== undefined && ms > untilMs) return false;
    return true;
  });
}

export function parseSearchDateBound(raw: string, now: Date = new Date()): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("date bound must not be empty");
  const relMatch = trimmed.match(RELATIVE_DURATION_PATTERN);
  if (relMatch) {
    const count = Number(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const fixedMs = FIXED_UNIT_MS[unit];
    const bound = new Date(now);
    if (fixedMs !== undefined) {
      bound.setTime(now.getTime() - count * fixedMs);
    } else if (unit === "mo") {
      bound.setUTCMonth(bound.getUTCMonth() - count);
    } else {
      bound.setUTCFullYear(bound.getUTCFullYear() - count);
    }
    return bound.toISOString().slice(0, 10);
  }
  if (ISO_DATE_PATTERN.test(trimmed)) return trimmed;
  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) throw new Error(`Invalid date bound: ${raw}`);
  return new Date(parsedMs).toISOString();
}

export function buildCheckoutMetadata(pr: number, sourceBranch: string, prUrl: string | undefined, remote = "origin"): Record<string, string> {
  return {
    remote,
    merge: `refs/heads/${sourceBranch}`,
    "alpha-bitbucket-pr": String(pr),
    "alpha-bitbucket-pr-head-ref": sourceBranch,
    "alpha-bitbucket-pr-url": prUrl ?? "",
  };
}

export function unsupportedBitbucketOp(op: BitbucketOp, reason: string): string {
  return `Unsupported bitbucket op '${op}' in Alpha: ${reason}`;
}

export function serverRepositoryPayload(repo: BitbucketRepoRef): object {
  return {
    slug: repo.slug,
    project: { key: repo.projectOrWorkspace },
  };
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePr(value: unknown): number | string | string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.map((item) => typeof item === "number" || typeof item === "string" ? String(item).trim() : "").filter(Boolean);
    return out.length ? out : undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const out = raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function clampInteger(value: unknown, defaultValue: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed === "https://api.bitbucket.org" ? "https://bitbucket.org" : trimmed;
}

function isCloudBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "bitbucket.org" || new URL(baseUrl).hostname === "api.bitbucket.org";
  } catch {
    return false;
  }
}

function parseHttpsRemote(value: string, fallbackBaseUrl?: string): BitbucketRepoRef | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const baseUrl = fallbackBaseUrl ?? `${url.protocol}//${url.host}`;
  const kind = isCloudBaseUrl(baseUrl) ? "cloud" : "server";

  if (parts[0] === "scm" && parts.length >= 3) {
    return { kind, baseUrl, projectOrWorkspace: parts[1], slug: stripGitSuffix(parts[2]) };
  }
  const projectIndex = parts.indexOf("projects");
  const repoIndex = parts.indexOf("repos");
  if (projectIndex >= 0 && repoIndex === projectIndex + 2 && parts[projectIndex + 1] && parts[repoIndex + 1]) {
    return { kind, baseUrl, projectOrWorkspace: parts[projectIndex + 1], slug: stripGitSuffix(parts[repoIndex + 1]) };
  }
  return { kind, baseUrl, projectOrWorkspace: parts[0], slug: stripGitSuffix(parts[1]) };
}

function parseSshRemote(value: string, fallbackBaseUrl?: string): BitbucketRepoRef | undefined {
  if (!/^ssh:\/\//i.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const baseUrl = fallbackBaseUrl ?? `https://${url.hostname}`;
  return {
    kind: isCloudBaseUrl(baseUrl) ? "cloud" : "server",
    baseUrl,
    projectOrWorkspace: parts[0],
    slug: stripGitSuffix(parts[1]),
  };
}

function parseScpLikeRemote(value: string, fallbackBaseUrl?: string): BitbucketRepoRef | undefined {
  const match = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (!match) return undefined;
  const parts = match[2].split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const baseUrl = fallbackBaseUrl ?? `https://${match[1]}`;
  return {
    kind: isCloudBaseUrl(baseUrl) ? "cloud" : "server",
    baseUrl,
    projectOrWorkspace: parts[0],
    slug: stripGitSuffix(parts[1]),
  };
}

function splitRepo(value: string): [string | undefined, string | undefined] {
  const parts = value.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length !== 2) return [undefined, undefined];
  return [parts[0], stripGitSuffix(parts[1])];
}

function stripGitSuffix(value: string): string {
  return decodeURIComponent(value).replace(/\.git$/i, "");
}

function escapeCloudQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function booleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const raw = value[key];
  return typeof raw === "boolean" ? raw : undefined;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const raw = value[key];
  return Array.isArray(raw) ? raw : [];
}

function nestedString(value: Record<string, unknown>, path: Array<string | number>): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return typeof current === "string" && current.trim() ? current : undefined;
}

function push(lines: string[], label: string, value: string | undefined): void {
  if (value) lines.push(`${label}: ${value}`);
}
