import { createHash } from "node:crypto";

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function contentTag(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 4).toUpperCase();
}

export function matchesContentTag(text: string, expected: string): boolean {
  const normalized = expected.trim();
  return normalized === contentTag(text) || normalized.toLowerCase() === contentHash(text);
}

export function renderAnchoredFile(path: string, content: string, startLine = 1): string {
  return renderAnchoredFileWithTag(path, content, contentTag(content), startLine);
}

export function renderAnchoredFileWithTag(path: string, content: string, tag: string, startLine = 1): string {
  const lines = content.split(/\r?\n/);
  const numbered = lines.map((line, index) => `${String(startLine + index).padStart(5, " ")}  ${line}`);
  return [`[${path}#${tag}]`, "```text", ...numbered, "```"].join("\n");
}
