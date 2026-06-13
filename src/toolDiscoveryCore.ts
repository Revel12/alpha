export type DiscoverableToolSource = "builtin" | "mcp" | "extension" | "custom";

export interface DiscoverableTool {
  name: string;
  label: string;
  summary: string;
  source: DiscoverableToolSource;
  serverName?: string;
  mcpToolName?: string;
  schemaKeys: string[];
}

export interface DiscoverableToolSearchDocument {
  tool: DiscoverableTool;
  termFrequencies: Map<string, number>;
  length: number;
}

export interface DiscoverableToolSearchIndex {
  documents: DiscoverableToolSearchDocument[];
  averageLength: number;
  documentFrequencies: Map<string, number>;
}

export interface DiscoverableToolSearchResult {
  tool: DiscoverableTool;
  score: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_DELTA = 1.0;

const FIELD_WEIGHTS = {
  name: 6,
  label: 4,
  serverName: 2,
  mcpToolName: 4,
  summary: 2,
  schemaKey: 1,
} as const;

export function buildDiscoverableToolSearchIndex(tools: Iterable<DiscoverableTool>): DiscoverableToolSearchIndex {
  const documents = Array.from(tools, buildSearchDocument);
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
  const documentFrequencies = new Map<string, number>();

  for (const document of documents) {
    for (const token of new Set(document.termFrequencies.keys())) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }
  }

  return { documents, averageLength, documentFrequencies };
}

export function searchDiscoverableTools(index: DiscoverableToolSearchIndex, query: string, limit: number): DiscoverableToolSearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) throw new Error("Query must contain at least one letter or number.");
  if (index.documents.length === 0) return [];

  const queryTermCounts = new Map<string, number>();
  for (const token of queryTokens) {
    queryTermCounts.set(token, (queryTermCounts.get(token) ?? 0) + 1);
  }

  return index.documents
    .map((document) => {
      let score = 0;
      for (const [token, queryTermCount] of queryTermCounts) {
        const termFrequency = document.termFrequencies.get(token) ?? 0;
        if (termFrequency === 0) continue;
        const documentFrequency = index.documentFrequencies.get(token) ?? 0;
        const idf = Math.log(1 + (index.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
        const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));
        score += queryTermCount * idf * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + normalization) + BM25_DELTA);
      }
      return { tool: document.tool, score };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit);
}

export function schemaKeys(schema: object): string[] {
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.keys(properties as Record<string, unknown>).sort();
}

function buildSearchDocument(tool: DiscoverableTool): DiscoverableToolSearchDocument {
  const termFrequencies = new Map<string, number>();
  addWeightedTokens(termFrequencies, tool.name, FIELD_WEIGHTS.name);
  addWeightedTokens(termFrequencies, tool.label, FIELD_WEIGHTS.label);
  addWeightedTokens(termFrequencies, tool.serverName, FIELD_WEIGHTS.serverName);
  addWeightedTokens(termFrequencies, tool.mcpToolName, FIELD_WEIGHTS.mcpToolName);
  addWeightedTokens(termFrequencies, tool.summary, FIELD_WEIGHTS.summary);
  for (const key of tool.schemaKeys) {
    addWeightedTokens(termFrequencies, key, FIELD_WEIGHTS.schemaKey);
  }
  const length = [...termFrequencies.values()].reduce((sum, value) => sum + value, 0);
  return { tool, termFrequencies, length };
}

function addWeightedTokens(termFrequencies: Map<string, number>, value: string | undefined, weight: number): void {
  if (!value) return;
  for (const token of tokenize(value)) {
    termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);
  }
}

function tokenize(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}
