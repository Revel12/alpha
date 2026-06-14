import { parseReportFindingDetails } from "../reviewCore";
import type { ToolDefinition } from "../types";

export const reportFindingTool: ToolDefinition = {
  name: "report_finding",
  summary: "Hidden review-subagent tool for recording a structured code review finding.",
  async run(args) {
    const details = parseReportFindingDetails(JSON.parse(args));
    if (!details) {
      throw new Error("report_finding requires title, body, priority P0-P3, confidence 0..1, file_path, line_start, and line_end.");
    }
    const location = `${details.file_path}:${details.line_start}${details.line_end !== details.line_start ? `-${details.line_end}` : ""}`;
    return {
      markdown: `Finding recorded: ${details.priority} ${details.title}\nLocation: ${location}\nConfidence: ${(details.confidence * 100).toFixed(0)}%`,
      details,
    };
  },
};
