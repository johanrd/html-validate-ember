// What a file's result depends on besides its own content: the project
// files it imports, transitively, plus the project-wide inputs that reach
// every file without an import (ambient declarations, module
// augmentations, installed packages). The cache keys include
// `dependencySha`, so a change anywhere upstream misses for every file
// downstream — the shape of tsc's incremental `referencedMap`, keyed on
// file content rather than on the exported signature, so stricter than
// tsc, never looser. The closure is needed with Glint off too: the
// resolver reads an imported component's template to substitute its tag.
//
// Imports are found by scanning the text for specifiers (`from`,
// `import`, `import()`, `/// <reference path>`), not by parsing.
// Resolution follows tsc: relative paths; tsconfig `paths` (longest
// prefix wins) against `baseUrl` or the directory of the config that
// declares them; `baseUrl`; `extends` (relative, and packages through
// their `tsconfig` field or `tsconfig.json`), later entries overriding
// earlier ones; TypeScript's `.js` → `.ts` rewrite; extension probing
// with `.gts`/`.gjs` first; directory `index` files. A `.ts`/`.js`
// module's co-located `.hbs` template counts as part of it. A resolved
// file is taken by its real path; anything under `node_modules` is a
// package and covered by the lockfile sha. Workspace sources reached
// through a symlink or a `../` path are project files. Without a
// tsconfig only relative imports resolve.
//
// Memos re-validate against the file system: file records on mtime and
// size, module resolution on the mtime of every directory it probed,
// tsconfig paths on the config chain's content, the list of project-wide
// inputs on the mtime of the directories walked. `assumeStaticFileSystem`
// (the CLI) trusts them for the rest of the process.

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

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`[html-validate-ember] ${message}\n`);
}

// A one-shot run (the CLI) sees the file system as it was at start, like a
// non-watch `tsc`: memos are trusted after their first fill. A long-lived
// host keeps re-validating.
let staticFileSystem = false;
export function assumeStaticFileSystem(): void {
  staticFileSystem = true;
}

function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

// --- file content, memoised on mtime and size -------------------------------

interface FileRecord {
  mtimeMs: number;
  size: number;
  sha: string;
  /** Specifiers, scanned on first use; the content is not kept. */
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
  let contents: string | null;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let imports: string[] | undefined;
  const record: FileRecord = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha: sha256(contents),
    imports: () => {
      if (!imports) {
        imports = importSpecifiers(contents!);
        contents = null;
      }
      return imports;
    },
  };
  fileRecords.set(file, record);
  return record;
}

/** Import specifiers and `/// <reference path>` targets, in order of appearance. */
export function importSpecifiers(contents: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"\n]+)['"]/g,
    /^\s*\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"\n]+)['"]/gm,
  ];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const spec = match[1];
      if (spec && !found.includes(spec)) found.push(spec);
    }
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
const NO_TSCONFIG: ProjectPaths = { id: 0, baseUrl: null, pathsBase: null, paths: [], chain: [] };
const projectPathsByTsconfig = new Map<string, ProjectPaths>();
let projectPathsReads = 0;

// tsconfig.json is JSON with comments and trailing commas. Strings are
// copied verbatim; comments and trailing commas are removed outside them.
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
    } else if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
      } else {
        out += ch;
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out);
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
    warnOnce(
      `tsconfig:${tsconfigPath}`,
      `${tsconfigPath}: cannot parse (${err instanceof Error ? err.message : String(err)}); imports through tsconfig paths are not tracked for the cache.`,
    );
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

function projectPaths(tsconfigPath: string | null): ProjectPaths {
  if (!tsconfigPath) return NO_TSCONFIG;
  const cached = projectPathsByTsconfig.get(tsconfigPath);
  if (cached && (staticFileSystem || cached.chain.every(([file, sha]) => fileRecord(file)?.sha === sha))) return cached;
  const fresh = readTsconfigChain(tsconfigPath);
  projectPathsByTsconfig.set(tsconfigPath, fresh);
  return fresh;
}

/** Sha over the tsconfig and every config it extends. */
export function tsconfigChainSha(tsconfigPath: string): string {
  return sha256(projectPaths(tsconfigPath).chain.map(([file, sha]) => `${file}\0${sha}`).join('\n'));
}

// --- module resolution -----------------------------------------------------------

interface Resolution {
  file: string | null;
  /** Directories probed; the memo is valid while their mtimes hold. */
  dirs: string[];
}
const resolutionByKey = new Map<string, Resolution>();
const probeByCandidate = new Map<string, Resolution>();
const dirMtimes = new Map<string, number>();

// Drops memoised resolutions and probes that touched a directory whose
// mtime moved — a file was created, deleted or renamed there.
function revalidateDirectories(): void {
  if (staticFileSystem) return;
  const changed = new Set<string>();
  for (const [dir, mtime] of dirMtimes) {
    const now = mtimeOf(dir);
    if (now !== mtime) {
      changed.add(dir);
      dirMtimes.set(dir, now);
    }
  }
  if (changed.size === 0) return;
  for (const map of [resolutionByKey, probeByCandidate]) {
    for (const [key, entry] of map) {
      if (entry.dirs.some((dir) => changed.has(dir))) map.delete(key);
    }
  }
}

function watch(dir: string, probed: Set<string>): void {
  probed.add(dir);
  if (!dirMtimes.has(dir)) dirMtimes.set(dir, mtimeOf(dir));
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
// tried from every importing directory.
function probeFile(candidate: string, probed: Set<string>): string | null {
  const memo = probeByCandidate.get(candidate);
  if (memo) {
    for (const dir of memo.dirs) probed.add(dir);
    return memo.file;
  }
  const dirs = new Set<string>();
  watch(watchedDirectory(candidate), dirs);
  // `index` files live one level deeper.
  if (fs.existsSync(candidate)) watch(candidate, dirs);
  const stem = candidate.replace(/\.(?:js|mjs|cjs|jsx)$/, '');
  const attempts = [candidate, ...EXTENSIONS.map((ext) => stem + ext), ...EXTENSIONS.map((ext) => path.join(candidate, `index${ext}`))];
  let file: string | null = null;
  for (const attempt of attempts) {
    try {
      if (fs.statSync(attempt).isFile()) {
        file = fs.realpathSync.native(attempt);
        break;
      }
    } catch {
      // next
    }
  }
  for (const dir of dirs) probed.add(dir);
  probeByCandidate.set(candidate, { file, dirs: [...dirs] });
  return file;
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
export function resolveProjectImport(spec: string, fromFile: string, tsconfigPath: string | null): string | null {
  return resolveWith(spec, fromFile, projectPaths(tsconfigPath));
}

function resolveWith(spec: string, fromFile: string, paths: ProjectPaths): string | null {
  const memoKey = `${paths.id}\0${path.dirname(fromFile)}\0${spec}`;
  const memo = resolutionByKey.get(memoKey);
  if (memo) return memo.file;
  const probed = new Set<string>();
  const file = resolveUncached(spec, fromFile, paths, probed);
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

// A `.ts`/`.js` module's template can live next to it or under
// `templates/components/`; the resolver reads it, so it is part of the
// module for the cache.
function hbsPeers(file: string): string[] {
  const m = /^(.*)\/components\/([^/]+)\.(?:ts|js)$/.exec(file);
  const peers = [file.replace(/\.(?:ts|js)$/, '.hbs')];
  if (m) peers.push(path.join(m[1]!, 'templates', 'components', `${m[2]!}.hbs`));
  return peers.filter((peer) => peer !== file && fileRecord(peer) !== null);
}

// --- closure ----------------------------------------------------------------------

// Directories are re-validated once per `dependencySha` (which walks
// many closures), and on every direct call.
let insideSha = false;
let revalidatedInsideSha = false;

/** Project files `file` imports, transitively (real absolute paths, sorted, without `file` itself). */
export function dependencyClosure(file: string, contents: string, tsconfigPath: string | null, specifiers = importSpecifiers(contents)): string[] {
  if (!insideSha || !revalidatedInsideSha) {
    revalidateDirectories();
    revalidatedInsideSha = insideSha;
  }
  const paths = projectPaths(tsconfigPath);
  const root = path.resolve(file);
  const seen = new Set<string>([root]);
  const queue: Array<[string, string[]]> = [[root, specifiers]];
  for (const peer of hbsPeers(root)) seen.add(peer);
  while (queue.length > 0) {
    const [from, specs] = queue.pop()!;
    for (const spec of specs) {
      const dep = resolveWith(spec, from, paths);
      if (!dep || seen.has(dep)) continue;
      seen.add(dep);
      for (const peer of hbsPeers(dep)) seen.add(peer);
      const record = fileRecord(dep);
      if (record) queue.push([dep, record.imports()]);
    }
  }
  seen.delete(root);
  return [...seen].sort();
}

// --- project-wide inputs -------------------------------------------------------

// The directory the project's inputs are found under: the tsconfig's, or
// without one the nearest with a package.json.
function projectRootFor(file: string, tsconfigPath: string | null): string {
  if (tsconfigPath) return path.dirname(tsconfigPath);
  let dir = path.dirname(path.resolve(file));
  while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  return dir;
}

// The nearest lockfile at or above the project root (a workspace keeps
// one at the repository root).
function lockfileFor(projectRoot: string): string | null {
  let dir = projectRoot;
  for (;;) {
    for (const name of LOCKFILES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (dir === path.dirname(dir)) return null;
    dir = path.dirname(dir);
  }
}

// Files whose declarations reach every file without an import: `.d.ts`
// files, source files with `declare module` / `declare global` (registry
// augmentations), and the lockfile. A nested directory with its own
// package.json is another project and is not walked. The walk is
// re-validated on the mtimes of the directories it visited.
interface ProjectInputs {
  files: string[];
  dirs: Array<[string, number]>;
}
const projectInputsByRoot = new Map<string, ProjectInputs>();

function projectInputFiles(projectRoot: string): string[] {
  const cached = projectInputsByRoot.get(projectRoot);
  if (cached && (staticFileSystem || cached.dirs.every(([dir, mtime]) => mtimeOf(dir) === mtime))) return cached.files;
  const files: string[] = [];
  const dirs: Array<[string, number]> = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirs.push([dir, mtimeOf(dir)]);
    if (dir !== projectRoot && entries.some((entry) => entry.name === 'package.json')) return;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (entry.name.endsWith('.d.ts')) {
        files.push(full);
      } else if (/\.(?:ts|tsx|gts|gjs)$/.test(entry.name)) {
        try {
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes('declare ') && GLOBAL_DECLARATION.test(text)) files.push(full);
        } catch {
          // unreadable — skip
        }
      }
    }
  };
  walk(projectRoot);
  const lockfile = lockfileFor(projectRoot);
  if (lockfile) files.push(lockfile);
  files.sort();
  projectInputsByRoot.set(projectRoot, { files, dirs });
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
const inputsShaByRoot = new Map<string, { own: string; closure: string }>();

function projectInputsSha(projectRoot: string, tsconfigPath: string | null, withImports: boolean): string {
  const memo = inputsShaByRoot.get(projectRoot);
  if (memo && staticFileSystem) return withImports ? memo.closure : memo.own;
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
  inputsShaByRoot.set(projectRoot, shas);
  return withImports ? shas.closure : shas.own;
}

// Under a static file system a file's sha is computed once per content.
const shaByFile = new Map<string, { contentSha: string; sha: string }>();

/**
 * Sha over everything `file`'s result can depend on besides its own
 * content: its import closure and the project-wide inputs (ambient
 * declarations, module augmentations, the lockfile) — for a `.hbs`
 * template, the inputs with everything they import.
 */
export function dependencySha(file: string, contents: string, tsconfigPath: string | null): string {
  const contentSha = sha256(contents);
  const memo = staticFileSystem ? shaByFile.get(file) : undefined;
  if (memo && memo.contentSha === contentSha) return memo.sha;
  insideSha = true;
  try {
    const projectRoot = projectRootFor(file, tsconfigPath);
    const hash = crypto.createHash('sha256');
    hashFiles(hash, projectRoot, dependencyClosure(file, contents, tsconfigPath));
    hash.update(projectInputsSha(projectRoot, tsconfigPath, file.endsWith('.hbs')));
    const sha = hash.digest('hex');
    shaByFile.set(file, { contentSha, sha });
    return sha;
  } finally {
    insideSha = false;
    revalidatedInsideSha = false;
  }
}
