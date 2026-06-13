import * as vscode from "vscode";
import {
  duckDuckGoHtmlUrl,
  formatWebSearchForLlm,
  parseDuckDuckGoHtml,
  parseWebSearchInput,
} from "../webSearchCore";
import type { AlphaContext, ToolDefinition } from "../types";

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  summary: "Search the web for up-to-date information using the configured Alpha web-search provider.",
  async run(args, ctx) {
    const input = parseWebSearchInput(JSON.parse(args));
    const provider = vscode.workspace.getConfiguration("alpha").get<"disabled" | "duckduckgo_html">("webSearch.provider", "duckduckgo_html");
    if (provider === "disabled") {
      return { markdown: "Error: No web search provider configured." };
    }

    const url = duckDuckGoHtmlUrl(input);
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: "https://html.duckduckgo.com/",
      },
    });
    if (!response.ok) {
      return { markdown: `Error: DuckDuckGo HTML search failed: ${response.status} ${response.statusText}` };
    }

    const html = await response.text();
    const sources = parseDuckDuckGoHtml(html, input.num_search_results ?? input.limit ?? 10);
    const formatted = formatWebSearchForLlm({
      provider: "duckduckgo_html",
      sources,
      searchQueries: [input.query],
    });
    const artifact = ctx.artifacts.add(`web_search ${input.query}`, formatted);
    const footer = `\n\n---\nprovider: duckduckgo_html\nfull result: artifact://${artifact.id}`;
    return { markdown: `${formatted}${footer}` };
  },
};
