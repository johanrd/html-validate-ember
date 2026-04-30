// Disk cache for Glint extraction results.
//
// The Glint pipeline (`extractAttrTypeMap`) is the dominant cost when
// `--glint` is on — TS program rebuilds + per-file `rewriteModule` +
// `getTypeChecker().getTypeAtLocation` calls. The result is a pure
// function of (file content + tsconfig content + plugin version), so we
// can cache it on disk and skip the work on repeat runs (CI,
// pre-commit hooks, IDE re-validation).
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
  result: ExtractionResult,
): void {
  if (CACHE_DISABLED) return;
  const cacheDir = findCacheDir(filename);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const payload: CacheEntry = {
      pluginVersion: PLUGIN_VERSION,
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
