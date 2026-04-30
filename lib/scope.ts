// Extract static-string lookups for the blanker to resolve `{{NAME}}` and
// `{{this.field}}` references to their literal values. Map keys are the
// path's `original` text — `'NAME'` for top-level consts (same-file or
// imported), `'this.field'` for class fields — so a single Map covers
// both lookups.
//
// Regex-based: more elaborate JS parsing (Babel / acorn) could resolve
// more cases (let, namespaced imports, getters returning literals,
// path-aliased imports), but the regex approach catches the common
// patterns without a heavy dependency.

import fs from 'node:fs';
import path from 'node:path';

// Match a JS string literal (single- or double-quoted, no escapes,
// no embedded newlines). Used by both the const and field regexes.
const STRING_LITERAL_RE = `(['"])([^'"\\n\\r]*)\\2`;

// `const NAME = '...'` and `export const NAME = '...'`. The optional
// `: Type` annotation between name and `=` is matched defensively.
const CONST_RE = new RegExp(
  String.raw`^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+?)?\s*=\s*${STRING_LITERAL_RE}\s*;?\s*$`,
  'gm',
);

// Same shape but only matches `export const` — used when scanning an
// imported module for its exported string constants.
const EXPORTED_CONST_RE = new RegExp(
  String.raw`^[ \t]*export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+?)?\s*=\s*${STRING_LITERAL_RE}\s*;?\s*$`,
  'gm',
);

// Class-field initializers — `field = 'value'`, `field: Type = 'value'`,
// `@tracked field = 'value'`, `static readonly field = 'value'`, etc.
// Matched only inside a class body (see `findClassBodies`) to avoid
// false positives from top-level assignments.
const FIELD_RE = new RegExp(
  String.raw`^[ \t]*(?:@\w+\s+)?(?:static\s+)?(?:declare\s+)?(?:public\s+|private\s+|protected\s+)?(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=\n]+?)?\s*=\s*${STRING_LITERAL_RE}\s*;?\s*$`,
  'gm',
);

// `class Name { ` / `class Name extends X { ` / `export class …` etc.
// All forms are anchored by `class\s+\w+`.
const CLASS_OPEN_RE = /\bclass\s+\w+(?:\s+extends\s+[^{]+)?\s*\{/g;

// `import { A, B as C } from './path';` — named-imports only. Default
// imports, namespace imports, and side-effect imports don't carry
// values we can resolve, so we ignore them.
const IMPORT_RE = /^[ \t]*import\s*\{\s*([^}]+?)\s*\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;

// Find each class body's character range by brace-matching. We don't
// trust the class-open regex alone to delimit the body — nested braces
// (object types, decorator args, function bodies) need balancing.
function findClassBodies(source: string): Array<{ start: number; end: number }> {
  const bodies: Array<{ start: number; end: number }> = [];
  CLASS_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_OPEN_RE.exec(source)) !== null) {
    const bodyStart = m.index + m[0].length; // just past `{`
    let depth = 1;
    let i = bodyStart;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth === 0) {
      bodies.push({ start: bodyStart, end: i - 1 }); // body content excludes `}`
    }
  }
  return bodies;
}

// Resolve a relative import path against the importer's directory. We
// only resolve relative imports (./ or ../) — package imports and
// path-aliased imports (e.g., `webapp/...` via tsconfig paths) would
// require a config-aware resolver and aren't worth the complexity for
// what the blanker can do with the result anyway.
//
// Tries common extensions and `index.*` directory entries in roughly
// the order Node / TypeScript would.
function resolveRelativeImport(fromFile: string, importPath: string): string | null {
  if (!importPath.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), importPath);
  const candidates = [
    base,
    base + '.gts',
    base + '.gjs',
    base + '.ts',
    base + '.tsx',
    base + '.js',
    base + '.jsx',
    base + '.mjs',
    base + '.cjs',
    path.join(base, 'index.gts'),
    path.join(base, 'index.gjs'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.cjs'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // not present, try next
    }
  }
  return null;
}

// Per-process cache of (filename → exported string consts). Populated
// lazily; never cleared within a process. Fine for the CLI / IDE
// re-validation; a long-running language server that wants to see
// edits to imported modules would need invalidation (deferred).
const exportedConstsCache = new Map<string, Map<string, string>>();

function extractExportedConsts(filename: string): Map<string, string> {
  const hit = exportedConstsCache.get(filename);
  if (hit !== undefined) return hit;
  const map = new Map<string, string>();
  let source: string;
  try {
    source = fs.readFileSync(filename, 'utf8');
  } catch {
    exportedConstsCache.set(filename, map);
    return map;
  }
  EXPORTED_CONST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORTED_CONST_RE.exec(source)) !== null) {
    const name = m[1];
    const value = m[3];
    if (name !== undefined && value !== undefined) {
      map.set(name, value);
    }
  }
  exportedConstsCache.set(filename, map);
  return map;
}

// Parse `import { A, B as C } from './path'` and add resolved values
// (under their LOCAL names) into `into`. Only relative imports are
// followed (./ or ../). Skips path-aliased and package imports.
function addImportedConsts(
  into: Map<string, string>,
  source: string,
  sourceFilename: string,
): void {
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    const namedList = m[1];
    const importPath = m[2];
    if (!namedList || !importPath) continue;
    if (!importPath.startsWith('.')) continue;
    const resolved = resolveRelativeImport(sourceFilename, importPath);
    if (!resolved) continue;
    const exported = extractExportedConsts(resolved);
    if (exported.size === 0) continue;
    for (const item of namedList.split(',')) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      // Handle `Foo` and `Foo as Bar`.
      const renameMatch = /^(\S+)\s+as\s+(\S+)$/.exec(trimmed);
      const sourceName = renameMatch ? renameMatch[1] : trimmed;
      const localName = renameMatch ? renameMatch[2] : trimmed;
      if (!sourceName || !localName) continue;
      const value = exported.get(sourceName);
      if (value !== undefined && !into.has(localName)) {
        into.set(localName, value);
      }
    }
  }
}

/**
 * Build the static-string scope for a `.gts`/`.gjs` source file:
 *   - Top-level `const NAME = '...'` declarations (same file)
 *   - `this.field` initializers from class bodies (same file), keyed
 *     as `this.<name>` so `path.original` matches
 *   - `import { NAME } from './path'` imported string consts (one
 *     level deep; relative paths only) — only applied when
 *     `sourceFilename` is provided
 *
 * Same-file definitions take precedence over imports of the same name.
 */
export function extractStringScope(
  source: string,
  sourceFilename?: string,
): Map<string, string> {
  const map = new Map<string, string>();

  // Top-level `const NAME = '...'` (same file) — keyed by bare name.
  CONST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONST_RE.exec(source)) !== null) {
    const name = m[1];
    const value = m[3];
    if (name !== undefined && value !== undefined) {
      map.set(name, value);
    }
  }

  // Class fields `field = '...'` — keyed by `this.<name>`.
  for (const body of findClassBodies(source)) {
    const slice = source.slice(body.start, body.end);
    FIELD_RE.lastIndex = 0;
    let f: RegExpExecArray | null;
    while ((f = FIELD_RE.exec(slice)) !== null) {
      const name = f[1];
      const value = f[3];
      if (name !== undefined && value !== undefined) {
        map.set(`this.${name}`, value);
      }
    }
  }

  // Imported consts from sibling files — only applied when we have a
  // filename to resolve against. Same-file consts already populated
  // above take precedence (handled by the `!into.has(localName)`
  // check inside `addImportedConsts`).
  if (sourceFilename) {
    addImportedConsts(map, source, sourceFilename);
  }

  return map;
}

// Test-only: clear the imported-consts cache so per-process state
// doesn't leak between fixture runs.
export function _clearScopeCache(): void {
  exportedConstsCache.clear();
}
