// Disk cache for Glint extraction results.
//
// The Glint pipeline (`extractAttrTypeMap`) is the dominant cost when
// `--glint` is on — TS program rebuilds + per-file `rewriteModule` +
// `getTypeChecker().getTypeAtLocation` calls. The result is a pure
// function of (file content + tsconfig content + type backend + plugin
// version + plugin source content), so we can cache it on disk and skip the work
// on repeat runs (CI, pre-commit hooks, IDE re-validation).
//
// Why plugin source content (not just version)? On release the package
// version bumps and the cache invalidates cleanly. During local plugin
// development the version stays fixed but `lib/` changes between every
// `npm run build` — without hashing the source, every iteration hits
// stale cache entries and silently runs the OLD resolver logic.
//
// Cache layout:
//   <projectRoot>/node_modules/.cache/html-validate-ember/glint/
//     <sha-of-absolute-path>.json   one entry per source file
//
// One entry per file path, not per (content × tsconfig × version)
// combination — so editing a file overwrites its previous entry rather
// than leaving stale entries to accumulate. The stored entry carries
// the file SHA, tsconfig SHA, and plugin version inside the JSON; the
// reader compares stored vs. current and treats any mismatch as a miss.
//
// `node_modules/.cache/` is the conventional ignored cache location used
// by Babel, ESLint, etc. — your existing `.gitignore` already excludes
// it.
//
// Bypass via `HVE_NO_CACHE=1` (env) for debugging the Glint pipeline
// without cache hits.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { ComponentAttrs } from './builtin-components.js';

// Walk up from this module looking for the nearest `package.json` so the
// version is found regardless of whether we're running from source
// (vitest: `lib/cache.ts`) or the built layout (`dist/lib/cache.js`).
function findPluginVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // fall through to parent directory
      }
    }
    dir = path.dirname(dir);
  }
  return '0.0.0';
}
const PLUGIN_VERSION = findPluginVersion();

// SHA over the plugin's own library code (the directory this module
// lives in). The cache entries are produced by these files; if the
// files change between runs, the stored entries can be wrong even
// though the source-under-validation and tsconfig haven't moved.
// Bumping the package version on release covers consumers of the
// published package, but during local plugin development the version
// stays fixed and stale entries silently mask fixes — so include the
// source content too.
//
// Computed once at module load: it's the same for every cache call in
// a process. Costs ~50ms on first import, then cached.
function computePluginSourceSha(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  const files: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(?:js|ts|cjs|mjs|hbs|gjs|gts|json)$/.test(entry.name)) {
        // Skip `.d.ts` and source maps — they don't drive behaviour.
        if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.map')) continue;
        files.push(full);
      }
    }
  }
  walk(start);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(path.relative(start, f));
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(f));
    } catch {
      // unreadable file — skip
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}
const PLUGIN_SOURCE_SHA = computePluginSourceSha();

const CACHE_DISABLED = process.env['HVE_NO_CACHE'] === '1';

/** Type info for a mustache at a `"line:column"` key (template-relative). */
export type AttrTypeInfo =
  | { kind: 'string-literal'; values: [string] }
  | { kind: 'string-literal-union'; values: string[] }
  | { kind: 'other'; text: string };

/** Result shape returned by `extractAttrTypeMap` and round-tripped through cache. */
export interface ExtractionResult {
  attrTypeMap: Map<string, AttrTypeInfo>;
  componentTagMap: Map<string, string>;
  componentAttrMap: Map<string, ComponentAttrs>;
}

interface CacheEntry {
  pluginVersion: string;
  backend: string;
  pluginSourceSha: string;
  tsconfigSha: string;
  fileSha: string;
  attrTypeMap: Array<[string, AttrTypeInfo]>;
  componentTagMap: Array<[string, string]>;
  componentAttrMap: Array<[string, ComponentAttrs]>;
}

// In-memory cache for the SHA of each tsconfig file (read once per
// process; tsconfigs rarely change mid-run).
const tsconfigShaCache = new Map<string, string>();

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function getTsconfigSha(tsconfigPath: string): string {
  const cached = tsconfigShaCache.get(tsconfigPath);
  if (cached !== undefined) return cached;
  let sha: string;
  try {
    const contents = fs.readFileSync(tsconfigPath, 'utf8');
    sha = sha256(contents);
  } catch {
    sha = 'no-tsconfig';
  }
  tsconfigShaCache.set(tsconfigPath, sha);
  return sha;
}

// Walk up from a file to find the project root (where node_modules/
// lives). Falls back to the file's directory if no node_modules is
// found — cache writes will use that local dir.
function findCacheDir(start: string): string {
  let dir = path.dirname(start);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'node_modules'))) {
      return path.join(dir, 'node_modules', '.cache', 'html-validate-ember', 'glint');
    }
    dir = path.dirname(dir);
  }
  return path.join(path.dirname(start), '.cache', 'html-validate-ember', 'glint');
}

// One-entry-per-path file naming: hash of the absolute path. Editing
// the file overwrites this single entry; we never keep stale versions.
function entryPath(cacheDir: string, filename: string): string {
  return path.join(cacheDir, `${sha256(path.resolve(filename))}.json`);
}

// Map<K, V> — JSON.stringify produces `{}` for Maps. Convert to/from
// arrays of [K, V] pairs so the cache round-trips cleanly.
function serializeMap<K, V>(map: Map<K, V>): Array<[K, V]> {
  return [...map.entries()];
}

function deserializeMap<K, V>(arr: Array<[K, V]> | undefined): Map<K, V> {
  return new Map(arr ?? []);
}

// Returns cached extraction results for `filename` when the stored
// entry's SHAs match current (file content + tsconfig + plugin version).
// Returns null on miss / stale / disabled / read or parse error.
export function readCache(
  filename: string,
  contents: string,
  tsconfigPath: string,
  backend: string,
): ExtractionResult | null {
  if (CACHE_DISABLED) return null;
  const cacheDir = findCacheDir(filename);
  const file = entryPath(cacheDir, filename);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: CacheEntry;
  try {
    parsed = JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
  // Validate stored SHAs against current. Any mismatch = stale = miss.
  // The next writeCache will overwrite the file (one entry per path).
  const fileSha = sha256(contents);
  const tsconfigSha = getTsconfigSha(tsconfigPath);
  if (
    parsed.pluginVersion !== PLUGIN_VERSION ||
    parsed.backend !== backend ||
    parsed.pluginSourceSha !== PLUGIN_SOURCE_SHA ||
    parsed.tsconfigSha !== tsconfigSha ||
    parsed.fileSha !== fileSha
  ) {
    return null;
  }
  return {
    attrTypeMap: deserializeMap(parsed.attrTypeMap),
    componentTagMap: deserializeMap(parsed.componentTagMap),
    componentAttrMap: deserializeMap(parsed.componentAttrMap),
  };
}

// Write extraction results to the cache. Best-effort: failure is swallowed
// (cache miss next time, but validation still works). Overwrites the
// file's existing entry — there's only ever one cache file per source
// file path.
export function writeCache(
  filename: string,
  contents: string,
  tsconfigPath: string,
  backend: string,
  result: ExtractionResult,
): void {
  if (CACHE_DISABLED) return;
  const cacheDir = findCacheDir(filename);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const payload: CacheEntry = {
      pluginVersion: PLUGIN_VERSION,
      backend,
      pluginSourceSha: PLUGIN_SOURCE_SHA,
      tsconfigSha: getTsconfigSha(tsconfigPath),
      fileSha: sha256(contents),
      attrTypeMap: serializeMap(result.attrTypeMap),
      componentTagMap: serializeMap(result.componentTagMap),
      componentAttrMap: serializeMap(result.componentAttrMap),
    };
    fs.writeFileSync(entryPath(cacheDir, filename), JSON.stringify(payload));
  } catch {
    // ignore — cache is best-effort
  }
}
