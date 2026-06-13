import { buildDiscoverableToolSearchIndex, searchDiscoverableTools } from "../toolDiscoveryCore";
import { getDiscoverableAlphaToolMetadata, isDiscoverableAlphaToolName } from "../toolRegistry";
import type { ToolDefinition } from "../types";

interface SearchToolBm25Input {
  query: string;
  limit: number;
}

export const searchToolBm25Tool: ToolDefinition = {
  name: "search_tool_bm25",
  summary: "Search hidden discoverable tool metadata and activate matching tools.",
  async run(args, ctx) {
    const input = parseInput(args);
    const activeNames = new Set(["read", "bash", "edit", "search_tool_bm25", ...ctx.discoveredTools.list()]);
    const tools = getDiscoverableAlphaToolMetadata(activeNames);
    const index = buildDiscoverableToolSearchIndex(tools);
    const ranked = searchDiscoverableTools(index, input.query, input.limit);
    const names = ranked.map((result) => result.tool.name).filter(isDiscoverableAlphaToolName);
    const activated = ctx.discoveredTools.add(names);

    return {
      markdown: JSON.stringify({
        query: input.query,
        activated_tools: activated,
        match_count: ranked.length,
        total_tools: index.documents.length,
        matches: ranked.map((result) => ({
          name: result.tool.name,
          score: Number(result.score.toFixed(6)),
          schema_keys: result.tool.schemaKeys,
        })),
      }),
    };
  },
};

function parseInput(args: string): SearchToolBm25Input {
  const raw = JSON.parse(args) as { query?: unknown; limit?: unknown };
  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  if (!query) throw new Error("Query is required and must not be empty.");
  const limit = typeof raw.limit === "number" && Number.isInteger(raw.limit) && raw.limit > 0 ? raw.limit : 8;
  return { query, limit };
}
