export function applyJsonPath(data: unknown, path: string): unknown {
  let current = data;
  for (const token of parseJsonPath(path)) {
    if (current === null || current === undefined) return undefined;
    if (typeof token === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[token];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function parseJsonPath(path: string): Array<string | number> {
  const normalized = path.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized) return [];

  if (normalized.includes("/") && !normalized.includes("[")) {
    return normalized.split("/").filter(Boolean).map((segment) => tokenForSegment(safeDecodeURIComponent(segment)));
  }

  const tokens: Array<string | number> = [];
  let i = normalized.startsWith(".") ? 1 : 0;

  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === ".") {
      i++;
      continue;
    }
    if (ch === "[") {
      const close = normalized.indexOf("]", i + 1);
      if (close === -1) throw new Error(`Invalid JSON path: missing ] in ${path}`);
      const raw = normalized.slice(i + 1, close).trim();
      if (!raw) throw new Error(`Invalid JSON path: empty [] in ${path}`);
      const quote = raw[0];
      if ((quote === "\"" || quote === "'") && raw.endsWith(quote)) {
        tokens.push(raw.slice(1, -1).replace(/\\(["'\\])/g, "$1"));
      } else {
        tokens.push(tokenForSegment(raw));
      }
      i = close + 1;
      continue;
    }

    const start = i;
    while (i < normalized.length && /[A-Za-z0-9_-]/.test(normalized[i])) i++;
    if (start === i) throw new Error(`Invalid JSON path: unexpected token '${normalized[i]}' in ${path}`);
    tokens.push(tokenForSegment(normalized.slice(start, i)));
  }
  return tokens;
}

function tokenForSegment(segment: string): string | number {
  return /^\d+$/.test(segment) ? Number(segment) : segment;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
