// Disk cache for Glint extraction results.
//
// The Glint pipeline (`extractAttrTypeMap`) is the dominant cost when
// `--glint` is on — TS program rebuilds + per-file `rewriteModule` +
// `getTypeChecker().getTypeAtLocation` calls. The result is a pure
// function of (file content + tsconfig content + plugin source), so we
// can cache it on disk and skip the work on repeat runs (CI,
// pre-commit hooks, IDE re-validation).
//
// "Plugin source" is keyed two ways:
//   - `package.json` `version` field — invalidates between releases.
//   - SHA of the plugin's core source files (lib/, blank.ts, etc.) —
//     invalidates across in-development changes that don't bump the
//     `version` field. Without this, a dev who modifies the plugin
//     between local ecosystem-check runs gets stale cached results
//     because both `version` and consumer-file content stayed the
//     same.
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

// Walk up from this module looking for the nearest `package.json`. Used
// for both reading the published version (cache invalidation between
// release versions) AND as the anchor for hashing core source files
// (cache invalidation across in-development plugin changes).
function findPluginRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function findPluginVersion(root: string | null): string {
  if (!root) return '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version?: string;
    };
    if (pkg.version) return pkg.version;
  } catch {
    // fall through
  }
  return '0.0.0';
}

// Hash core plugin source files at module load. This is the cache key
// component that catches in-development plugin changes — the
// `package.json` `version` field rarely changes between commits, so a
// version-only cache key reuses stale extraction results across
// plugin code changes (e.g., a new bug-fix branch is merged but the
// previous cache entry is still considered valid).
//
// We hash a fixed list of the core extraction-affecting files. Both
// `.ts` (source / dev) and `.js` (built / shipped) are tried; missing
// files are silently skipped. A hash mismatch on read invalidates the
// entry just like a fileSha or tsconfigSha mismatch.
function findPluginSourceSha(root: string | null): string {
  if (!root) return 'no-root';
  // Files whose content meaningfully affects the extraction result:
  // the transformer, blanker, Glint integration, and shared helpers.
  // Test files and triage docs are excluded — they don't change the
  // extraction logic.
  const candidates = [
    'index.ts', 'index.js',
    'blank.ts', 'blank.js',
    'transform.ts', 'transform.js',
    'lib/glint.ts', 'lib/glint.js',
    'lib/component-attrs.ts', 'lib/component-attrs.js',
    'lib/dynamic-value.ts', 'lib/dynamic-value.js',
    'lib/builtin-components.ts', 'lib/builtin-components.js',
    'lib/cache.ts', 'lib/cache.js',
    'lib/multipass-dedupe.ts', 'lib/multipass-dedupe.js',
    'lib/scope.ts', 'lib/scope.js',
  ];
  const hash = crypto.createHash('sha256');
  for (const rel of candidates) {
    try {
      const content = fs.readFileSync(path.join(root, rel), 'utf8');
      hash.update(`${rel}:${content}\n`);
    } catch {
      // missing — `.ts` not present in shipped layout, `.js` not
      // present in source layout; skip silently.
    }
  }
  // 16 hex chars is plenty for cache-key collision avoidance and keeps
  // the stored entry compact.
  return hash.digest('hex').slice(0, 16);
}

const PLUGIN_ROOT = findPluginRoot();
const PLUGIN_VERSION = findPluginVersion(PLUGIN_ROOT);
const PLUGIN_SOURCE_SHA = findPluginSourceSha(PLUGIN_ROOT);

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
  // Hash of the plugin's core source files. Catches cache invalidation
  // across in-development plugin changes that don't bump
  // `package.json` version (the typical case during fix-branch work).
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
  result: ExtractionResult,
): void {
  if (CACHE_DISABLED) return;
  const cacheDir = findCacheDir(filename);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const payload: CacheEntry = {
      pluginVersion: PLUGIN_VERSION,
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
