import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { ensureToolPermission } from "../approval";
import { bitbucketApproval, bitbucketApprovalDetails } from "../approvalCore";
import {
  bitbucketApiUrl,
  bitbucketCodeSearchUrls,
  bitbucketCommitsUrl,
  bitbucketPrPayload,
  bitbucketPrDiffUrl,
  bitbucketSearchReposUrl,
  buildCheckoutMetadata,
  applyBitbucketDateFilter,
  formatBitbucketCodeSearchResults,
  formatBitbucketList,
  formatBitbucketPr,
  formatBitbucketRepo,
  parseBitbucketPrUrl,
  parseBitbucketInput,
  prIdentifiers,
  prNumber,
  requireBitbucketCodeSearchQuery,
  resolveBitbucketAuth,
  resolveBitbucketRepo,
  unsupportedBitbucketOp,
  type BitbucketInput,
  type BitbucketRepoRef,
} from "../bitbucketCore";
import type { AlphaContext, ToolDefinition } from "../types";
import { workspaceRoot } from "../workspace";

const execFileAsync = promisify(execFile);

export const bitbucketTool: ToolDefinition = {
  name: "bitbucket",
  summary: "Interact with Bitbucket repositories and pull requests.",
  async run(args, ctx) {
    const input = parseBitbucketInput(args);
    await ensureToolPermission(
      { name: "bitbucket", approval: bitbucketApproval, formatApprovalDetails: bitbucketApprovalDetails },
      input,
      ctx,
    );

    const options = await resolveOptions(input);
    switch (input.op) {
      case "repo_view":
        return { markdown: formatBitbucketRepo(options.repo, await bitbucketJson(options, "GET", bitbucketApiUrl(options.repo, ""))) };
      case "pr_view":
        return { markdown: formatBitbucketPr(options.repo, await bitbucketJson(options, "GET", prUrl(options.repo, prNumber(input)))) };
      case "pr_create":
        return { markdown: formatBitbucketPr(options.repo, await bitbucketJson(options, "POST", prListUrl(options.repo), bitbucketPrPayload(options.repo, await fillPrInput(options, input)))) };
      case "pr_comment":
        return { markdown: await commentPr(options, input) };
      case "pr_approve":
        return { markdown: await approvePr(options, input, "POST") };
      case "pr_unapprove":
        return { markdown: await approvePr(options, input, "DELETE") };
      case "pr_decline":
        return { markdown: formatBitbucketPr(options.repo, await bitbucketJson(options, "POST", `${prUrl(options.repo, prNumber(input))}/decline`)) };
      case "pr_merge":
        return { markdown: await mergePr(options, input) };
      case "search_prs":
        return { markdown: await searchPrs(options, input) };
      case "search_repos":
        return { markdown: formatBitbucketList("Bitbucket repositories", await bitbucketJson(options, "GET", bitbucketSearchReposUrl(options.repo, input.query, input.limit)), input.limit) };
      case "search_code":
        return { markdown: await searchCode(options, input) };
      case "search_commits":
        return { markdown: await searchCommits(options, input) };
      case "run_watch":
        return { markdown: unsupportedBitbucketOp("run_watch", "Bitbucket Pipelines/build-status APIs differ across Cloud and Server/Data Center. Use Bitbucket UI or a configured project command through `bash`.") };
      case "pr_checkout":
        return { markdown: await checkoutPr(options, input) };
      case "pr_push":
        return { markdown: await pushPr(options, input) };
    }
  },
};

interface BitbucketToolOptions {
  repo: BitbucketRepoRef;
  authHeader?: string;
  cwd: string;
  codeSearchPathTemplates: string[];
}

async function resolveOptions(input: BitbucketInput): Promise<BitbucketToolOptions> {
  const config = vscode.workspace.getConfiguration("alpha");
  const cwd = workspaceRoot().fsPath;
  const remote = await git(["remote", "get-url", "origin"], cwd).catch(() => "");
  const baseUrl = config.get<string>("bitbucket.baseUrl", "") || undefined;
  const tokenEnv = config.get<string>("bitbucket.tokenEnv", "BITBUCKET_TOKEN");
  const usernameEnv = config.get<string>("bitbucket.usernameEnv", "BITBUCKET_USERNAME");
  const passwordEnv = config.get<string>("bitbucket.passwordEnv", "BITBUCKET_PASSWORD");
  const codeSearchPathTemplates = normalizeStringArray(config.get<unknown>("bitbucket.codeSearchPathTemplates", []));
  return {
    repo: resolveBitbucketRepo(input, remote, baseUrl),
    authHeader: resolveBitbucketAuth({
      authHeader: process.env.BITBUCKET_AUTH_HEADER,
      token: process.env[tokenEnv],
      username: process.env[usernameEnv],
      password: process.env[passwordEnv],
    }),
    cwd,
    codeSearchPathTemplates,
  };
}

function prListUrl(repo: BitbucketRepoRef): string {
  return bitbucketApiUrl(repo, repo.kind === "cloud" ? "/pullrequests" : "/pull-requests");
}

function prUrl(repo: BitbucketRepoRef, pr: number): string {
  return bitbucketApiUrl(repo, repo.kind === "cloud" ? `/pullrequests/${pr}` : `/pull-requests/${pr}`);
}

async function commentPr(options: BitbucketToolOptions, input: BitbucketInput): Promise<string> {
  if (!input.comment) throw new Error("bitbucket pr_comment requires comment.");
  const pr = prNumber(input);
  const body = options.repo.kind === "cloud" ? { content: { raw: input.comment } } : { text: input.comment };
  const data = await bitbucketJson(options, "POST", `${prUrl(options.repo, pr)}/comments`, body);
  return `Commented on PR #${pr}.\n${JSON.stringify(data, null, 2)}`;
}

async function approvePr(options: BitbucketToolOptions, input: BitbucketInput, method: "POST" | "DELETE"): Promise<string> {
  const pr = prNumber(input);
  await bitbucketJson(options, method, `${prUrl(options.repo, pr)}/approve`);
  return `${method === "POST" ? "Approved" : "Removed approval from"} PR #${pr}.`;
}

async function mergePr(options: BitbucketToolOptions, input: BitbucketInput): Promise<string> {
  const pr = prNumber(input);
  let url = `${prUrl(options.repo, pr)}/merge`;
  if (options.repo.kind === "server") {
    const current = await bitbucketJson(options, "GET", prUrl(options.repo, pr)) as { version?: unknown };
    if (typeof current.version === "number") url += `?version=${current.version}`;
  }
  return formatBitbucketPr(options.repo, await bitbucketJson(options, "POST", url));
}

async function searchPrs(options: BitbucketToolOptions, input: BitbucketInput): Promise<string> {
  const state = (input.state ?? "OPEN").toUpperCase();
  const url = options.repo.kind === "cloud"
    ? bitbucketApiUrl(options.repo, "/pullrequests", { state, pagelen: input.limit, q: input.query ? `title ~ "${input.query.replace(/"/g, "\\\"")}"` : undefined })
    : bitbucketApiUrl(options.repo, "/pull-requests", { state, limit: input.limit });
  const data = await bitbucketJson(options, "GET", url);
  const values = Array.isArray((data as { values?: unknown }).values) ? (data as { values: unknown[] }).values : [];
  const dated = applyBitbucketDateFilter(values, input);
  if (!input.query || options.repo.kind === "cloud") return formatBitbucketList("Bitbucket pull requests", { values: dated }, input.limit);
  const needle = input.query.toLowerCase();
  return formatBitbucketList("Bitbucket pull requests", { values: dated.filter((item) => JSON.stringify(item).toLowerCase().includes(needle)) }, input.limit);
}

async function searchCode(options: BitbucketToolOptions, input: BitbucketInput): Promise<string> {
  const query = requireBitbucketCodeSearchQuery(input);
  const urls = bitbucketCodeSearchUrls(options.repo, input, options.codeSearchPathTemplates);
  if (!urls.length) {
    return unsupportedBitbucketOp(
      "search_code",
      "Bitbucket Cloud has no configured OMP-equivalent code-search endpoint in Alpha. Configure alpha.bitbucket.codeSearchPathTemplates, or check out the repo and use Alpha `search`/`find`/`read` for editable hashline results.",
    );
  }

  const errors: string[] = [];
  for (const url of urls) {
    try {
      const data = await bitbucketJson(options, "GET", url);
      return formatBitbucketCodeSearchResults(options.repo, query, data, input.limit);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return unsupportedBitbucketOp(
    "search_code",
    [
      "No Bitbucket code-search endpoint succeeded.",
      "Set alpha.bitbucket.codeSearchPathTemplates to the internal Server/Data Center search path exposed in your VDI.",
      "Templates may use {baseUrl}, {project}, {workspace}, {slug}, {repo}, {query}, and {limit}.",
      errors.length ? `Last error: ${errors[errors.length - 1]}` : undefined,
    ].filter(Boolean).join(" "),
  );
}

async function checkoutPr(options: BitbucketToolOptions, input: BitbucketInput): Promise<string> {
  const refs = prIdentifiers(input);
  const prRefs = refs.length ? refs : [String(prNumber(input))];
  const outcomes: string[] = [];
  const failures: string[] = [];
  for (const ref of prRefs) {
    try {
      outcomes.push(await checkoutOnePr(options, input, ref));
    } catch (error) {
      failures.push(`- ${ref}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length && !outcomes.length) throw new Error(`all ${failures.length} PR checkouts failed:\n${failures.join("\n")}`);
  return [
    `# ${outcomes.length} Bitbucket PR worktree${outcomes.length === 1 ? "" : "s"}`,
    ...outcomes,
    failures.length ? ["", "## Failed", ...failures].join("\n") : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}

async function pushPr(options: BitbucketToolOptions, input: BitbucketInput): Promise<string> {
  const branch = input.branch ?? (await git(["branch", "--show-current"], options.cwd)).trim();
  if (!branch) throw new Error("Could not determine current branch for bitbucket pr_push.");
  const remote = await git(["config", "--get", `branch.${branch}.pushRemote`], options.cwd).catch(() => "");
  const fallbackRemote = await git(["config", "--get", `branch.${branch}.remote`], options.cwd).catch(() => "");
  const sourceBranch = await git(["config", "--get", `branch.${branch}.alpha-bitbucket-pr-head-ref`], options.cwd).catch(() => "");
  const prUrl = await git(["config", "--get", `branch.${branch}.alpha-bitbucket-pr-url`], options.cwd).catch(() => "");
  if (!sourceBranch.trim()) {
    throw new Error(`branch ${branch} has no Bitbucket PR push metadata; check it out via op: pr_checkout first`);
  }
  const args = ["push", (remote || fallbackRemote || "origin").trim(), `HEAD:refs/heads/${sourceBranch.trim()}`];
  if (input.forceWithLease) args.splice(1, 0, "--force-with-lease");
  await git(args, options.cwd);
  return [`Pushed ${branch} to ${(remote || fallbackRemote || "origin").trim()}/${sourceBranch.trim()}.`, prUrl.trim() ? `PR: ${prUrl.trim()}` : undefined].filter(Boolean).join("\n");
}

async function checkoutOnePr(options: BitbucketToolOptions, input: BitbucketInput, prRef: string): Promise<string> {
  const parsed = parseBitbucketPrUrl(prRef);
  const pr = parsed.pr ?? Number(prRef.replace(/^#/, ""));
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`invalid PR identifier: ${prRef}`);
  const data = await bitbucketJson(options, "GET", prUrl(options.repo, pr));
  const sourceBranch = extractSourceBranch(data);
  if (!sourceBranch) throw new Error(`PR #${pr} did not include a source branch`);
  const url = extractHtmlUrl(data);
  const branch = input.branch && prIdentifiers(input).length <= 1 ? input.branch : `alpha-pr-${pr}`;
  const repoRoot = (await git(["rev-parse", "--show-toplevel"], options.cwd)).trim();
  const worktreePath = path.join(repoRoot, ".alpha", "worktrees", branch);
  const remoteRef = `refs/remotes/origin/${sourceBranch}`;

  await git(["fetch", "origin", `refs/pull-requests/${pr}/from:${remoteRef}`], repoRoot).catch(async () => {
    await git(["fetch", "origin", `refs/heads/${sourceBranch}:${remoteRef}`], repoRoot);
  });

  const branchExists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot).then(() => true, () => false);
  if (branchExists) {
    if (input.force) await git(["branch", "-f", branch, remoteRef], repoRoot);
  } else {
    await git(["branch", branch, remoteRef], repoRoot);
  }

  const existingWorktrees = await git(["worktree", "list", "--porcelain"], repoRoot).catch(() => "");
  const reused = existingWorktrees.includes(`branch refs/heads/${branch}\n`);
  if (!reused) {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await git(["worktree", "add", worktreePath, branch], repoRoot);
  }

  for (const [key, value] of Object.entries(buildCheckoutMetadata(pr, sourceBranch, url))) {
    await git(["config", `branch.${branch}.${key}`, value], repoRoot);
  }

  return [
    `## PR #${pr}: ${extractTitle(data) ?? "(untitled)"}`,
    `Branch: ${branch}`,
    `Worktree: ${worktreePath}${reused ? " (reused)" : ""}`,
    `Remote branch: origin/${sourceBranch}`,
    url ? `URL: ${url}` : undefined,
  ].filter(Boolean).join("\n");
}

function extractSourceBranch(data: unknown): string | undefined {
  const value = asRecord(data);
  return nestedString(value, ["source", "branch", "name"]) ?? nestedString(value, ["fromRef", "displayId"]);
}

function extractTitle(data: unknown): string | undefined {
  return stringField(asRecord(data), "title");
}

function extractHtmlUrl(data: unknown): string | undefined {
  const value = asRecord(data);
  return nestedString(value, ["links", "html", "href"]) ?? nestedString(value, ["links", "self", 0, "href"]);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function nestedString(value: Record<string, unknown>, pathSegments: Array<string | number>): string | undefined {
  let current: unknown = value;
  for (const segment of pathSegments) {
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

async function fillPrInput(options: BitbucketToolOptions, input: BitbucketInput): Promise<BitbucketInput> {
  if (!input.fill) return input;
  const sourceBranch = input.sourceBranch ?? input.branch ?? (await git(["branch", "--show-current"], options.cwd)).trim();
  const targetBranch = input.targetBranch ?? "main";
  const commits = await git(["log", "--format=%s%n%b%n---ALPHA-COMMIT---", `${targetBranch}..${sourceBranch}`], options.cwd).catch(() => "");
  const first = commits.split("---ALPHA-COMMIT---")[0]?.trim();
  if (!first && !input.title) throw new Error("fill=true could not derive PR title/body from local git commits.");
  const [titleLine, ...bodyLines] = (first ?? "").split(/\r?\n/);
  return {
    ...input,
    title: input.title ?? titleLine?.trim(),
    body: input.body ?? bodyLines.join("\n").trim(),
    sourceBranch,
    targetBranch,
  };
}

async function searchCommits(options: BitbucketToolOptions, input: BitbucketInput): Promise<string> {
  const data = await bitbucketJson(options, "GET", bitbucketCommitsUrl(options.repo, input.branch, input.limit));
  const rawValues = Array.isArray((data as { values?: unknown }).values) ? (data as { values: unknown[] }).values : [];
  const dated = applyBitbucketDateFilter(rawValues, input);
  const values = input.query
    ? dated.filter((item) => JSON.stringify(item).toLowerCase().includes(input.query?.toLowerCase() ?? ""))
    : dated;
  return formatCommitList(values, input.limit);
}

function formatCommitList(values: unknown[], limit: number): string {
  const commits = values.slice(0, limit);
  if (!commits.length) return "Bitbucket commits: no results.";
  const lines = [`Bitbucket commits: ${commits.length} result${commits.length === 1 ? "" : "s"}`];
  for (const item of commits) {
    const row = asRecord(item);
    const hash = stringField(row, "hash") ?? stringField(row, "id") ?? "?";
    const message = stringField(row, "message")?.split(/\r?\n/, 1)[0] ?? "(no message)";
    const author = nestedString(row, ["author", "user", "display_name"]) ?? nestedString(row, ["author", "displayName"]) ?? nestedString(row, ["author", "raw"]);
    const date = stringField(row, "date") ?? stringField(row, "authorTimestamp");
    lines.push(`- ${hash.slice(0, 12)} ${message}${author ? ` — ${author}` : ""}${date ? ` (${date})` : ""}`);
  }
  return lines.join("\n");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

export async function readBitbucketPrUrl(path: string, ctx: AlphaContext): Promise<{ url: string; label: string; content: string; contentType: "text/markdown" | "text/plain"; size: number }> {
  const parsed = parsePrInternalPath(path);
  const input: BitbucketInput = {
    op: "pr_view",
    pr: parsed.pr,
    limit: 20,
    dateField: "created",
    tail: 80,
  };
  const options = await resolveOptions(input);
  if (parsed.diff) {
    const fullDiff = await bitbucketText(options, "GET", bitbucketPrDiffUrl(options.repo, parsed.pr));
    const files = splitUnifiedDiff(fullDiff);
    const content = parsed.all
      ? fullDiff
      : parsed.index !== undefined
        ? files[parsed.index - 1]?.content ?? (() => { throw new Error(`PR #${parsed.pr} diff file ${parsed.index} not found; diff has ${files.length} file(s).`); })()
        : formatDiffListing(parsed.pr, files);
    return {
      url: parsed.all ? `pr://${parsed.pr}/diff/all` : parsed.index !== undefined ? `pr://${parsed.pr}/diff/${parsed.index}` : `pr://${parsed.pr}/diff`,
      label: parsed.index !== undefined ? `pr://${parsed.pr}/diff/${parsed.index}` : `pr://${parsed.pr}/diff`,
      content,
      contentType: "text/plain",
      size: Buffer.byteLength(content, "utf8"),
    };
  }
  const content = formatBitbucketPr(options.repo, await bitbucketJson(options, "GET", prUrl(options.repo, parsed.pr)));
  return {
    url: `pr://${parsed.pr}`,
    label: `pr://${parsed.pr}`,
    content,
    contentType: "text/markdown",
    size: Buffer.byteLength(content, "utf8"),
  };
}

function parsePrInternalPath(pathValue: string): { pr: number; diff: boolean; all: boolean; index?: number } {
  const parts = pathValue.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const pr = Number(parts[0]);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`pr:// URL requires a PR number, got: ${parts[0] ?? ""}`);
  const diff = parts[1] === "diff";
  const all = diff && parts[2] === "all";
  const index = diff && parts[2] && !all ? Number(parts[2]) : undefined;
  if (parts.length > 1 && !diff) throw new Error(`Unsupported pr:// URL path: pr://${parts.join("/")}`);
  if (parts.length > 2 && !all && (index === undefined || !Number.isInteger(index) || index <= 0)) throw new Error(`Unsupported pr:// URL path: pr://${parts.join("/")}`);
  return { pr, diff, all, index };
}

interface DiffFileSlice {
  path: string;
  content: string;
}

function splitUnifiedDiff(diff: string): DiffFileSlice[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const files: DiffFileSlice[] = [];
  let current: string[] = [];
  let currentPath = "";
  const flush = () => {
    if (current.length) files.push({ path: currentPath || `(file ${files.length + 1})`, content: current.join("\n") });
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length) {
      flush();
      current = [];
      currentPath = "";
    }
    if (!currentPath && line.startsWith("+++ ")) currentPath = line.replace(/^\+\+\+\s+b\//, "").replace(/^\+\+\+\s+/, "");
    current.push(line);
  }
  flush();
  return files;
}

function formatDiffListing(pr: number, files: DiffFileSlice[]): string {
  if (!files.length) return `PR #${pr} diff: no changed files.`;
  return [
    `PR #${pr} changed files:`,
    ...files.map((file, index) => `${index + 1}. ${file.path} (read pr://${pr}/diff/${index + 1})`),
    `Full diff: pr://${pr}/diff/all`,
  ].join("\n");
}

async function bitbucketJson(options: BitbucketToolOptions, method: "GET" | "POST" | "DELETE", url: string, body?: object): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (options.authHeader) headers.Authorization = options.authHeader;
  const response = await request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Bitbucket ${method} ${url} failed with HTTP ${response.statusCode}: ${response.body.slice(0, 2000)}`);
  }
  if (!response.body.trim()) return {};
  return JSON.parse(response.body);
}

async function bitbucketText(options: BitbucketToolOptions, method: "GET", url: string): Promise<string> {
  const headers: Record<string, string> = { Accept: "text/plain, text/x-diff, */*" };
  if (options.authHeader) headers.Authorization = options.authHeader;
  const response = await request(url, { method, headers });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Bitbucket ${method} ${url} failed with HTTP ${response.statusCode}: ${response.body.slice(0, 2000)}`);
  }
  return response.body;
}

function request(url: string, opts: { method: string; headers: Record<string, string>; body?: string }): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "http:" ? http : https;
    const req = transport.request(parsed, {
      method: opts.method,
      headers: {
        ...opts.headers,
        ...(opts.body ? { "Content-Length": Buffer.byteLength(opts.body).toString() } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}
