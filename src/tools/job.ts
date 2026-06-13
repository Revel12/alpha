import { cancelAsyncBashJob } from "../asyncBashJobs";
import type { BashJob, ToolDefinition } from "../types";

interface JobInput {
  poll?: string[];
  cancel?: string[];
  list?: boolean;
  id?: string;
}

type CancelStatus = "cancelled" | "not_found" | "already_completed";

const DEFAULT_POLL_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export const jobTool: ToolDefinition = {
  name: "job",
  summary: "Inspect, wait for, or cancel async Alpha jobs.",
  async run(args, ctx) {
    const input = parseJobInput(args);

    if (input.list && ((input.poll?.length ?? 0) > 0 || (input.cancel?.length ?? 0) > 0)) {
      throw new Error("`list` cannot be combined with `poll` or `cancel`.");
    }

    if (input.list) return { markdown: renderJobResult(ctx.bashJobs.list(), []) };

    const cancelOutcomes = (input.cancel ?? []).map((id) => cancelJob(id, ctx.bashJobs.get(id), ctx.bashJobs.update.bind(ctx.bashJobs)));
    const shouldPoll = input.poll !== undefined || cancelOutcomes.length === 0;

    if (!shouldPoll) {
      const cancelledJobs = (input.cancel ?? []).map((id) => ctx.bashJobs.get(id)).filter((job): job is BashJob => Boolean(job));
      return { markdown: renderJobResult(cancelledJobs, cancelOutcomes) };
    }

    const requestedPollIds = input.poll;
    const jobsToWatch = requestedPollIds
      ? requestedPollIds.map((id) => ctx.bashJobs.get(id)).filter((job): job is BashJob => Boolean(job))
      : ctx.bashJobs.list().filter((job) => job.status === "running");

    if (!jobsToWatch.length) {
      if (cancelOutcomes.length) {
        const cancelledJobs = (input.cancel ?? []).map((id) => ctx.bashJobs.get(id)).filter((job): job is BashJob => Boolean(job));
        return { markdown: renderJobResult(cancelledJobs, cancelOutcomes) };
      }
      return {
        markdown: requestedPollIds?.length
          ? `No matching jobs found for IDs: ${requestedPollIds.join(", ")}`
          : "No running background jobs to wait for.",
      };
    }

    const watchedIds = new Set(jobsToWatch.map((job) => job.id));
    const deadline = Date.now() + DEFAULT_POLL_WAIT_MS;
    while (!ctx.token.isCancellationRequested && Date.now() < deadline) {
      const latest = ctx.bashJobs.list().filter((job) => watchedIds.has(job.id));
      if (latest.some((job) => job.status !== "running")) {
        return { markdown: renderJobResult(latest, cancelOutcomes) };
      }
      await sleep(POLL_INTERVAL_MS);
    }

    return {
      markdown: renderJobResult(ctx.bashJobs.list().filter((job) => watchedIds.has(job.id)), cancelOutcomes),
    };
  },
};

function parseJobInput(args: string): JobInput {
  const trimmed = args.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Partial<JobInput>;
    return {
      list: parsed.list === true,
      poll: normalizeIdArray(parsed.poll),
      cancel: normalizeIdArray(parsed.cancel),
      id: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : undefined,
    };
  }

  return { poll: [trimmed], id: trimmed };
}

function normalizeIdArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("job poll/cancel must be arrays of job ids.");
  const ids = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error("job ids must be non-empty strings.");
    return item.trim();
  });
  return ids;
}

function cancelJob(
  id: string,
  job: BashJob | undefined,
  update: (id: string, patch: Partial<Omit<BashJob, "id" | "createdAt">>) => BashJob | undefined,
): { id: string; status: CancelStatus; message: string } {
  if (!job) return { id, status: "not_found", message: `Background job not found: ${id}` };
  if (job.status !== "running") {
    return { id, status: "already_completed", message: `Background job ${id} is already ${job.status}.` };
  }

  const cancelled = cancelAsyncBashJob(id);
  update(id, { status: "cancelled", error: cancelled ? undefined : "Cancellation requested; process handle was no longer active." });
  return cancelled
    ? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
    : { id, status: "cancelled", message: `Marked background job ${id} cancelled; process handle was no longer active.` };
}

function renderJobResult(jobs: BashJob[], cancelled: Array<{ id: string; status: CancelStatus; message: string }>): string {
  const lines: string[] = [];

  if (cancelled.length) {
    lines.push(`## Cancelled (${cancelled.length})`, "");
    for (const outcome of cancelled) lines.push(`- ${outcome.message}`);
    lines.push("");
  }

  const uniqueJobs = dedupeJobs(jobs);
  const completed = uniqueJobs.filter((job) => job.status !== "running");
  const running = uniqueJobs.filter((job) => job.status === "running");

  if (completed.length) {
    lines.push(`## Completed (${completed.length})`, "");
    for (const job of completed) {
      lines.push(`### ${job.id} [${job.type ?? "bash"}] - ${job.status}`);
      lines.push(`Label: ${job.command}`);
      lines.push(`Duration: ${formatDuration(job)}`);
      if (job.exitCode !== undefined) lines.push(`Exit: ${job.exitCode}`);
      if (job.timedOut !== undefined) lines.push(`Timed out: ${job.timedOut}`);
      if (job.output) lines.push("", "```text", job.output.trimEnd(), "```");
      if (job.error) lines.push(`Error: ${job.error}`);
      if (job.artifactId) lines.push(`Raw output: artifact://${job.artifactId}`);
      lines.push("");
    }
  }

  if (running.length) {
    lines.push(`## Still Running (${running.length})`, "");
    for (const job of running) {
      lines.push(`- \`${job.id}\` [${job.type ?? "bash"}] - ${job.command} (${formatDuration(job)})`);
    }
  }

  if (!lines.length) return "No Alpha background jobs.";
  return lines.join("\n").trimEnd();
}

function dedupeJobs(jobs: BashJob[]): BashJob[] {
  const seen = new Set<string>();
  const out: BashJob[] = [];
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    out.push(job);
  }
  return out;
}

function formatDuration(job: BashJob): string {
  const ms = job.wallTimeMs ?? Math.max(0, Date.now() - Date.parse(job.createdAt));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
