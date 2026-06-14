export function structuralDiagnostics(displayPath: string, text: string): string[] {
  if (!displayPath.toLowerCase().endsWith(".py")) return [];
  return duplicateTopLevelPythonDefinitions(displayPath, text);
}

export function duplicateTopLevelPythonDefinitions(displayPath: string, text: string): string[] {
  const seen = new Map<string, number>();
  const results: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(lines[index]);
    if (!match) continue;
    const name = match[1];
    const line = index + 1;
    const firstLine = seen.get(name);
    if (firstLine !== undefined) {
      results.push(`- ${displayPath}:${line}:1 Warning [alpha-python]: duplicate top-level function \`${name}\`; first defined on line ${firstLine}.`);
    } else {
      seen.set(name, line);
    }
  }
  return results;
}
