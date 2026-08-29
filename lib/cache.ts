// Disk cache for Glint extraction results.
//
// The Glint pipeline (`extractAttrTypeMap`) is the dominant cost when
// `--glint` is on — TS program rebuilds + per-file `rewriteModule` +
// `getTypeChecker().getTypeAtLocation` calls. The result is a pure
// function of (file content + the content of the files it depends on,
// see `lib/deps.ts` + tsconfig content + type backend + plugin version
// + plugin source content), so we can cache it on disk and skip the work
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
// the file SHA, dependency SHA, tsconfig SHA, and plugin version inside
// the JSON; the reader compares stored vs. current and treats any
// mismatch as a miss.
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
import { dependencySha, sha256, tsconfigChainSha } from './deps.js';

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

// SHA over the plugin's own code: the root sources and `lib/`. The cache entries are produced by these files; if the
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
  // The package root (`dist/` when built, the repo when run from source):
  // `blank` and `transform` live there, next to `lib/`.
  const start = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
        // Only `lib/` below the root: not node_modules, tests or fixtures.
        if (dir !== start || entry.name === 'lib') walk(full);
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
  dependencySha: string;
  attrTypeMap: Array<[string, AttrTypeInfo]>;
  componentTagMap: Array<[string, string]>;
  componentAttrMap: Array<[string, ComponentAttrs]>;
}

// The tsconfig and every config it extends; `lib/deps.ts` re-validates
// the chain against the file system.
function getTsconfigSha(tsconfigPath: string): string {
  return tsconfigChainSha(tsconfigPath);
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

/**
 * The dependency sha a Glint result is read and written under. Computed
 * once by the caller and passed to both `readCache` and `writeCache`; not
 * computed at all when the cache is off.
 */
export function cacheDependencies(filename: string, contents: string, tsconfigPath: string): string {
  return CACHE_DISABLED ? 'disabled' : dependencySha(filename, contents, tsconfigPath);
}

// Returns cached extraction results for `filename` when the stored
// entry's SHAs match current (file content + tsconfig + plugin version).
// Returns null on miss / stale / disabled / read or parse error.
export function readCache(
  filename: string,
  contents: string,
  tsconfigPath: string,
  backend: string,
  dependencies = dependencySha(filename, contents, tsconfigPath),
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
    parsed.fileSha !== fileSha ||
    parsed.dependencySha !== dependencies
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
// file path. `dependencies` is the sha the result was computed under
// (from the matching `readCache`), so a dependency edited during the
// analysis cannot be stored as if it were reflected in the result.
export function writeCache(
  filename: string,
  contents: string,
  tsconfigPath: string,
  backend: string,
  result: ExtractionResult,
  dependencies = dependencySha(filename, contents, tsconfigPath),
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
      dependencySha: dependencies,
      attrTypeMap: serializeMap(result.attrTypeMap),
      componentTagMap: serializeMap(result.componentTagMap),
      componentAttrMap: serializeMap(result.componentAttrMap),
    };
    fs.writeFileSync(entryPath(cacheDir, filename), JSON.stringify(payload));
  } catch {
    // ignore — cache is best-effort
  }
}

// ---------------------------------------------------------------------------
// Transform-output cache: the blanked passes of a `.gts`/`.gjs` file, keyed
// by the file's content plus everything else the transform reads (the
// tsconfig, the environment switches). Same layout and lifetime rules as
// the Glint cache above, under `.../html-validate-ember/transform/`.
// ---------------------------------------------------------------------------

export interface CachedPass {
  content: string;
  error: string | null;
  dynamicContentOffsets: number[];
  attrInjections: Array<[number, Array<{ attr: string; value: string | null }>]>;
  disablePerElement: Array<[number, string[]]>;
}

export interface CachedTemplate {
  startOffset: number;
  endOffset: number;
  passes: CachedPass[];
}

interface TransformCacheEntry {
  pluginVersion: string;
  pluginSourceSha: string;
  key: string;
  templates: CachedTemplate[];
}

/** Everything the transform's output depends on besides the plugin itself. */
// The closure matters with Glint off too: the resolver reads an imported
// component's template to substitute its tag.
function dependenciesForKey(filename: string, contents: string, tsconfigPath: string | null): string {
  return CACHE_DISABLED ? 'disabled' : dependencySha(filename, contents, tsconfigPath);
}

export function transformCacheKey(filename: string, data: string, tsconfigPath: string | null, backendKind: string): string {
  return sha256(
    [
      data,
      dependenciesForKey(filename, data, tsconfigPath),
      tsconfigPath ? getTsconfigSha(tsconfigPath) : 'no-tsconfig',
      backendKind,
      process.env['HVE_GLINT'] ?? '',
      process.env['HVE_MAX_CONDITIONAL_BRANCHES'] ?? '',
    ].join('\0'),
  );
}

function transformEntryPath(filename: string): string {
  return path.join(findCacheDir(filename), '..', 'transform', `${sha256(path.resolve(filename))}.json`);
}

export function readTransformCache(filename: string, key: string): CachedTemplate[] | null {
  if (CACHE_DISABLED) return null;
  let parsed: TransformCacheEntry;
  try {
    parsed = JSON.parse(fs.readFileSync(transformEntryPath(filename), 'utf8')) as TransformCacheEntry;
  } catch {
    return null;
  }
  if (
    parsed.pluginVersion !== PLUGIN_VERSION ||
    parsed.pluginSourceSha !== PLUGIN_SOURCE_SHA ||
    parsed.key !== key
  ) {
    return null;
  }
  return parsed.templates;
}

export function writeTransformCache(filename: string, key: string, templates: CachedTemplate[]): void {
  if (CACHE_DISABLED) return;
  const file = transformEntryPath(filename);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload: TransformCacheEntry = {
      pluginVersion: PLUGIN_VERSION,
      pluginSourceSha: PLUGIN_SOURCE_SHA,
      key,
      templates,
    };
    fs.writeFileSync(file, JSON.stringify(payload));
  } catch {
    // ignore — cache is best-effort
  }
}
// ---------------------------------------------------------------------------
// Report cache: html-validate's (deduplicated) report for a file, keyed by
// the file's content and everything the report depends on: the resolved
// html-validate configuration, html-validate's own version, the tsconfig,
// and the environment switches. Under `.../html-validate-ember/report/`.
// ---------------------------------------------------------------------------

export interface CachedReport<Result> {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  results: Result[];
}

interface ReportCacheEntry<Result> extends CachedReport<Result> {
  pluginVersion: string;
  pluginSourceSha: string;
  key: string;
}

export function reportCacheKey(
  filename: string,
  contents: string,
  config: unknown,
  htmlValidateVersion: string,
  tsconfigPath: string | null,
  backendKind: string,
): string {
  return sha256(
    [
      contents,
      dependenciesForKey(filename, contents, tsconfigPath),
      JSON.stringify(config ?? null),
      htmlValidateVersion,
      tsconfigPath ? getTsconfigSha(tsconfigPath) : 'no-tsconfig',
      backendKind,
      process.env['HVE_GLINT'] ?? '',
      process.env['HVE_MAX_CONDITIONAL_BRANCHES'] ?? '',
    ].join('\0'),
  );
}

function reportEntryPath(filename: string): string {
  return path.join(findCacheDir(filename), '..', 'report', `${sha256(path.resolve(filename))}.json`);
}

export function readReportCache<Result>(filename: string, key: string): CachedReport<Result> | null {
  if (CACHE_DISABLED) return null;
  let parsed: ReportCacheEntry<Result>;
  try {
    parsed = JSON.parse(fs.readFileSync(reportEntryPath(filename), 'utf8')) as ReportCacheEntry<Result>;
  } catch {
    return null;
  }
  if (
    parsed.pluginVersion !== PLUGIN_VERSION ||
    parsed.pluginSourceSha !== PLUGIN_SOURCE_SHA ||
    parsed.key !== key
  ) {
    return null;
  }
  return { valid: parsed.valid, errorCount: parsed.errorCount, warningCount: parsed.warningCount, results: parsed.results };
}

export function writeReportCache<Result>(filename: string, key: string, report: CachedReport<Result>): void {
  if (CACHE_DISABLED) return;
  const file = reportEntryPath(filename);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload: ReportCacheEntry<Result> = {
      pluginVersion: PLUGIN_VERSION,
      pluginSourceSha: PLUGIN_SOURCE_SHA,
      key,
      ...report,
    };
    fs.writeFileSync(file, JSON.stringify(payload));
  } catch {
    // ignore — cache is best-effort
  }
}
