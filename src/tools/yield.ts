import { parseReviewYieldDetails } from "../reviewCore";
import type { ToolDefinition } from "../types";

export const yieldTool: ToolDefinition = {
  name: "yield",
  summary: "Hidden subagent tool for returning a final structured result to the parent.",
  async run(args) {
    const details = parseReviewYieldDetails(JSON.parse(args));
    if (!details) throw new Error("yield requires an object payload, usually { data: ... }.");
    if (details.status === "aborted") {
      return {
        markdown: `Subagent aborted${details.error ? `: ${details.error}` : "."}`,
        details,
      };
    }
    return {
      markdown: "Subagent final result received.",
      details,
    };
  },
};
