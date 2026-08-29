// What a file's Glint result depends on besides its own content: the
// project files it imports, transitively, plus the project-wide inputs
// that reach every file without an import (ambient declarations, module
// augmentations, installed packages). The cache keys include
// `dependencySha`, so a change anywhere upstream misses for every file
// downstream — the shape of tsc's incremental `referencedMap`, keyed on
// file content rather than on the exported signature, so stricter than
// tsc, never looser.
//
// Imports are found by scanning the text for specifiers, not by parsing.
// Resolution follows tsc: relative paths; tsconfig `paths` (longest
// prefix wins) against `baseUrl` or the directory of the config that
// declares them; `baseUrl`; `extends` (relative, and packages through
// their `tsconfig` field or `tsconfig.json`), later entries overriding
// earlier ones; TypeScript's `.js` → `.ts` rewrite; extension probing
// with `.gts`/`.gjs` first; directory `index` files. A resolved file is
// taken by its real path; anything under `node_modules` is a package and
// covered by the lockfile sha. Workspace sources reached through a
// symlink or a `../` path are project files.
//
// Memos re-validate against the file system: file records on mtime and
// size, module resolution on the mtime of every directory it probed,
// tsconfig paths on the config chain's content. The list of project-wide
// input files is found once per process; their content is re-checked.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const EXTENSIONS = ['.gts', '.gjs', '.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '.jsx'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'tmp']);
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const GLOBAL_DECLARATION = /^\s*(?:export\s+)?declare\s+(?:module|global)\b/m;

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`[html-validate-ember] ${message}\n`);
}
const warned = new Set<string>();

// A one-shot run (the CLI) sees the file system as it was at start, like a
// non-watch `tsc`: memos are trusted after their first fill. A long-lived
// host keeps re-validating them.
let staticFileSystem = false;
export function assumeStaticFileSystem(): void {
  staticFileSystem = true;
}

// --- file content, memoised on mtime and size -------------------------------

interface FileRecord {
  mtimeMs: number;
  size: number;
  sha: string;
  /** Specifiers, scanned on first use. */
  imports: () => string[];
}
const fileRecords = new Map<string, FileRecord>();

function fileRecord(file: string): FileRecord | null {
  if (staticFileSystem) {
    const cached = fileRecords.get(file);
    if (cached) return cached;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const cached = fileRecords.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let imports: string[] | undefined;
  const record = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha: sha256(contents),
    imports: () => (imports ??= importSpecifiers(contents)),
  };
  fileRecords.set(file, record);
  return record;
}

/** `from '...'`, `import '...'` and `import('...')` specifiers, in order of appearance. */
export function importSpecifiers(contents: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"\n]+)['"]/g;
  for (const match of contents.matchAll(pattern)) {
    const spec = match[1];
    if (spec && !found.includes(spec)) found.push(spec);
  }
  return found;
}

// --- tsconfig `paths` ---------------------------------------------------------

interface ProjectPaths {
  /** Distinct per read of the config chain; part of the resolution memo key. */
  id: number;
  /** Absolute directory non-relative specifiers resolve against. */
  baseUrl: string | null;
  /** Absolute directory `paths` targets resolve against. */
  pathsBase: string | null;
  /** Pattern → absolute target patterns. */
  paths: Array<[string, string[]]>;
  /** Config files read, with their content sha, for re-validation. */
  chain: Array<[string, string]>;
}
const projectPathsByTsconfig = new Map<string, ProjectPaths>();
let projectPathsReads = 0;

// tsconfig.json is JSON with comments and trailing commas.
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i === -1) i = text.length;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface TsconfigShape {
  extends?: unknown;
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
}

// The merged `baseUrl` and `paths` of a config and its `extends` chain.
// Like tsc: a child overrides its parents, a later `extends` entry
// overrides an earlier one, `paths` is replaced as a whole and resolves
// against the merged `baseUrl` or the directory of the config that
// declares it.
function readTsconfigChain(tsconfigPath: string, seen = new Set<string>()): ProjectPaths {
  const result: ProjectPaths = { id: ++projectPathsReads, baseUrl: null, pathsBase: null, paths: [], chain: [] };
  if (seen.has(tsconfigPath)) return result;
  seen.add(tsconfigPath);
  const record = fileRecord(tsconfigPath);
  if (!record) return result;
  result.chain.push([tsconfigPath, record.sha]);
  let config: TsconfigShape;
  try {
    config = (parseJsonc(fs.readFileSync(tsconfigPath, 'utf8')) ?? {}) as TsconfigShape;
  } catch (err) {
    warnOnce(`tsconfig:${tsconfigPath}`, `${tsconfigPath}: cannot parse (${err instanceof Error ? err.message : String(err)}); imports through tsconfig paths are not tracked for the cache.`);
    return result;
  }
  const dir = path.dirname(tsconfigPath);
  const parents = Array.isArray(config.extends) ? config.extends : [config.extends];
  for (const parent of parents) {
    if (typeof parent !== 'string') continue;
    const parentPath = resolveExtends(parent, dir);
    if (!parentPath) continue;
    const inherited = readTsconfigChain(parentPath, seen);
    result.chain.push(...inherited.chain);
    if (inherited.baseUrl) result.baseUrl = inherited.baseUrl;
    if (inherited.pathsBase) {
      result.pathsBase = inherited.pathsBase;
      result.paths = inherited.paths;
    }
  }
  const options = config.compilerOptions ?? {};
  if (typeof options.baseUrl === 'string') result.baseUrl = path.resolve(dir, options.baseUrl);
  if (options.paths && typeof options.paths === 'object') {
    result.pathsBase = dir;
    result.paths = Object.entries(options.paths as Record<string, unknown>)
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
      .map(([pattern, targets]) => [pattern, targets.filter((t): t is string => typeof t === 'string')]);
  }
  return result;
}

function resolveExtends(spec: string, fromDir: string): string | null {
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const abs = path.resolve(fromDir, spec);
    return fs.existsSync(abs) ? abs : fs.existsSync(`${abs}.json`) ? `${abs}.json` : null;
  }
  const req = createRequire(path.join(fromDir, 'package.json'));
  const attempts = path.extname(spec) ? [spec] : [`${spec}/tsconfig.json`, spec];
  try {
    const pkg = req(`${spec}/package.json`) as { tsconfig?: string };
    if (typeof pkg.tsconfig === 'string') attempts.unshift(`${spec}/${pkg.tsconfig}`);
  } catch {
    // no package.json at the root of the specifier — fine for deep paths
  }
  for (const attempt of attempts) {
    try {
      return req.resolve(attempt);
    } catch {
      // next
    }
  }
  return null;
}

function projectPaths(tsconfigPath: string): ProjectPaths {
  const cached = projectPathsByTsconfig.get(tsconfigPath);
  if (cached && (staticFileSystem || cached.chain.every(([file, sha]) => fileRecord(file)?.sha === sha))) return cached;
  const fresh = readTsconfigChain(tsconfigPath);
  projectPathsByTsconfig.set(tsconfigPath, fresh);
  return fresh;
}

// --- module resolution -----------------------------------------------------------

interface Resolution {
  file: string | null;
  /** Directories probed; the memo is valid while their mtimes hold. */
  dirs: string[];
}
const resolutionByKey = new Map<string, Resolution>();
const dirMtimes = new Map<string, number>();

function dirMtime(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return -1;
  }
}

// Drops memoised resolutions that probed a directory whose mtime moved —
// a file was created, deleted or renamed there. One stat per known
// directory per closure walk.
function revalidateDirectories(): void {
  if (staticFileSystem) return;
  const changed = new Set<string>();
  for (const [dir, mtime] of dirMtimes) {
    const now = dirMtime(dir);
    if (now !== mtime) {
      changed.add(dir);
      dirMtimes.set(dir, now);
    }
  }
  if (changed.size === 0) return;
  for (const [key, resolution] of resolutionByKey) {
    if (resolution.dirs.some((dir) => changed.has(dir))) resolutionByKey.delete(key);
  }
  for (const [candidate, probe] of probeByCandidate) {
    if (probe.dirs.some((dir) => changed.has(dir))) probeByCandidate.delete(candidate);
  }
}

// The directory whose mtime moves when a file at `p` is created: the
// nearest existing ancestor (creating `types/@ember/service.d.ts` first
// changes `types/`).
function watchedDirectory(p: string): string {
  let dir = path.dirname(p);
  while (dir !== path.dirname(dir) && !fs.existsSync(dir)) dir = path.dirname(dir);
  return dir;
}

// A candidate path is probed once; the same `types/@ember/service` is
// tried from every importing directory. Dropped with the memoised
// resolutions when a watched directory changes.
const probeByCandidate = new Map<string, { file: string | null; dirs: string[] }>();

function probeFile(candidate: string, probed: Set<string>): string | null {
  const memo = probeByCandidate.get(candidate);
  if (memo) {
    for (const dir of memo.dirs) probed.add(dir);
    return memo.file;
  }
  const dirs = new Set<string>();
  const file = probeUncached(candidate, dirs);
  for (const dir of dirs) probed.add(dir);
  probeByCandidate.set(candidate, { file, dirs: [...dirs] });
  return file;
}

function probeUncached(candidate: string, probed: Set<string>): string | null {
  const stem = candidate.replace(/\.(?:js|mjs|cjs|jsx)$/, '');
  const attempts = [candidate, ...EXTENSIONS.map((ext) => stem + ext), ...EXTENSIONS.map((ext) => path.join(candidate, `index${ext}`))];
  probed.add(watchedDirectory(candidate));
  for (const attempt of attempts) {
    try {
      if (fs.statSync(attempt).isFile()) return fs.realpathSync.native(attempt);
    } catch {
      // next
    }
  }
  if (fs.existsSync(candidate)) probed.add(candidate);
  return null;
}

// tsc's findBestPatternMatch: the pattern with the longest prefix wins.
function matchPaths(paths: Array<[string, string[]]>, spec: string): { wildcard: string; targets: string[] } | null {
  let best: { wildcard: string; targets: string[]; prefixLength: number } | null = null;
  for (const [pattern, targets] of paths) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (pattern === spec) return { wildcard: '', targets };
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    if (!best || prefix.length > best.prefixLength) {
      best = { wildcard: spec.slice(prefix.length, spec.length - suffix.length), targets, prefixLength: prefix.length };
    }
  }
  return best;
}

/** The project file `spec` refers to from `fromFile`, or null when it is a package or unresolved. */
export function resolveProjectImport(spec: string, fromFile: string, tsconfigPath: string): string | null {
  return resolveWith(spec, fromFile, projectPaths(tsconfigPath));
}

function resolveWith(spec: string, fromFile: string, paths: ProjectPaths): string | null {
  const memoKey = `${paths.id}\0${path.dirname(fromFile)}\0${spec}`;
  const memo = resolutionByKey.get(memoKey);
  if (memo) return memo.file;
  const probed = new Set<string>();
  const file = resolveUncached(spec, fromFile, paths, probed);
  for (const dir of probed) {
    if (!dirMtimes.has(dir)) dirMtimes.set(dir, dirMtime(dir));
  }
  resolutionByKey.set(memoKey, { file, dirs: [...probed] });
  return file;
}

function resolveUncached(spec: string, fromFile: string, { baseUrl, pathsBase, paths }: ProjectPaths, probed: Set<string>): string | null {
  const candidates: string[] = [];
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    candidates.push(path.resolve(path.dirname(fromFile), spec));
  } else {
    const match = matchPaths(paths, spec);
    if (match) {
      const base = baseUrl ?? pathsBase!;
      candidates.push(...match.targets.map((t) => path.resolve(base, t.replace('*', match.wildcard))));
    }
    if (baseUrl) candidates.push(path.resolve(baseUrl, spec));
  }
  for (const candidate of candidates) {
    const found = probeFile(candidate, probed);
    if (found && !found.split(path.sep).includes('node_modules')) return found;
  }
  return null;
}

// --- closure ----------------------------------------------------------------------

/** Project files `file` imports, transitively (real absolute paths, sorted, without `file` itself). */
// Directories are re-validated once per `dependencySha` (which walks
// many closures), and on every direct call.
let insideSha = false;
let revalidatedInsideSha = false;

export function dependencyClosure(file: string, contents: string, tsconfigPath: string, specifiers = importSpecifiers(contents)): string[] {
  if (!insideSha || !revalidatedInsideSha) {
    revalidateDirectories();
    revalidatedInsideSha = insideSha;
  }
  const paths = projectPaths(tsconfigPath);
  const root = path.resolve(file);
  const seen = new Set<string>([root]);
  const queue: Array<[string, string[]]> = [[root, specifiers]];
  while (queue.length > 0) {
    const [from, specs] = queue.pop()!;
    for (const spec of specs) {
      const dep = resolveWith(spec, from, paths);
      if (!dep || seen.has(dep)) continue;
      seen.add(dep);
      const record = fileRecord(dep);
      if (record) queue.push([dep, record.imports()]);
    }
  }
  seen.delete(root);
  return [...seen].sort();
}

// --- project-wide inputs -------------------------------------------------------

// Files whose declarations reach every file without an import: `.d.ts`
// files, and source files with `declare module` / `declare global`
// (registry augmentations). The list is found once per process; the
// content of each file is re-checked on every call.
const projectInputFilesByRoot = new Map<string, string[]>();

function projectInputFiles(projectRoot: string): string[] {
  let files = projectInputFilesByRoot.get(projectRoot);
  if (files) return files;
  files = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (entry.name.endsWith('.d.ts')) {
        files!.push(full);
      } else if (/\.(?:ts|tsx|gts|gjs)$/.test(entry.name)) {
        try {
          if (GLOBAL_DECLARATION.test(fs.readFileSync(full, 'utf8'))) files!.push(full);
        } catch {
          // unreadable — skip
        }
      }
    }
  };
  walk(projectRoot);
  files.push(...LOCKFILES.map((name) => path.join(projectRoot, name)));
  files.sort();
  projectInputFilesByRoot.set(projectRoot, files);
  return files;
}

function hashFiles(hash: crypto.Hash, projectRoot: string, files: string[]): void {
  for (const file of files) {
    const record = fileRecord(file);
    if (!record) continue;
    hash.update(path.relative(projectRoot, file));
    hash.update(record.sha);
    hash.update('\0');
  }
}

// The project-wide inputs reach a `.gts`/`.gjs`/`.ts` file through its
// own imports and the augmentations' declaring files, so their content
// is hashed. A `.hbs` template has no imports: components reach it only
// through the registry, so for it the inputs' whole import closure is
// hashed — an edit to any file the registry reaches invalidates every
// template. Both shas are computed once per run under a static file
// system.
const inputsShaByTsconfig = new Map<string, { own: string; closure: string }>();

function projectInputsSha(tsconfigPath: string, withImports: boolean): string {
  const memo = inputsShaByTsconfig.get(tsconfigPath);
  if (memo && staticFileSystem) return withImports ? memo.closure : memo.own;
  const projectRoot = path.dirname(tsconfigPath);
  const inputs = projectInputFiles(projectRoot);
  const closure = new Set<string>(inputs);
  for (const input of inputs) {
    const record = fileRecord(input);
    if (!record) continue;
    for (const dep of dependencyClosure(input, '', tsconfigPath, record.imports())) closure.add(dep);
  }
  const shaOf = (files: string[]) => {
    const hash = crypto.createHash('sha256');
    hashFiles(hash, projectRoot, files);
    return hash.digest('hex');
  };
  const shas = { own: shaOf(inputs), closure: shaOf([...closure].sort()) };
  inputsShaByTsconfig.set(tsconfigPath, shas);
  return withImports ? shas.closure : shas.own;
}

/**
 * Sha over everything `file`'s type information can depend on besides its
 * own content: its import closure and the project-wide inputs (ambient
 * declarations, module augmentations, the lockfile) — for a `.hbs`
 * template, the inputs with everything they import.
 */
export function dependencySha(file: string, contents: string, tsconfigPath: string | null): string {
  if (!tsconfigPath) return 'no-tsconfig';
  insideSha = true;
  try {
    const projectRoot = path.dirname(tsconfigPath);
    const hash = crypto.createHash('sha256');
    hashFiles(hash, projectRoot, dependencyClosure(file, contents, tsconfigPath));
    hash.update(projectInputsSha(tsconfigPath, file.endsWith('.hbs')));
    return hash.digest('hex');
  } finally {
    insideSha = false;
    revalidatedInsideSha = false;
  }
}
