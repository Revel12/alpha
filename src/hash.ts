import { createHash } from "node:crypto";

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function renderAnchoredFile(path: string, content: string, startLine = 1): string {
  const hash = contentHash(content);
  const lines = content.split(/\r?\n/);
  const numbered = lines.map((line, index) => `${String(startLine + index).padStart(5, " ")}  ${line}`);
  return [`¶${path}#${hash}`, "```text", ...numbered, "```"].join("\n");
}
