// Extract top-level string consts from a `.gts` source so the blanker can
// resolve `{{NAME}}` references to their static literal value.
//
// Regex-based: matches `const NAME = 'value'` or `const NAME = "value"` at
// any line start (allowing leading whitespace and an optional `export`).
// More elaborate JS parsing (Babel / acorn) could resolve more cases (let,
// namespaced imports, computed expressions) but this catches the common
// pattern.
export function extractStringScope(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re =
    /^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+?)?\s*=\s*(['"])([^'"\n\r]*)\2\s*;?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // Defensive: regex always produces these capture groups; satisfies
    // TypeScript's `noUncheckedIndexedAccess`.
    const name = m[1];
    const value = m[3];
    if (name !== undefined && value !== undefined) {
      map.set(name, value);
    }
  }
  return map;
}
