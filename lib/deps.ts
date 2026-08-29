// What a file's Glint result depends on besides its own content: the
// project files it imports, transitively, plus the project-wide inputs
// that reach every file without an import (ambient `.d.ts`, installed
// packages). The cache keys include `dependencySha`, so a change anywhere
// upstream misses for every file downstream — the same shape as tsc's
// incremental `referencedMap`, but keyed on file content rather than on
// the exported signature, so it is stricter than tsc, never looser.
//
// Imports are found by scanning the text for specifiers, not by parsing;
// a specifier that does not resolve to a project file is external (a
// package, covered by the lockfile sha) and ignored. Resolution follows
// relative paths, tsconfig `paths` and `baseUrl` (through relative and
// package `extends`), TypeScript's `.js` → `.ts` rewrite, extension
// probing with `.gts`/`.gjs` first, and directory `index` files.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const EXTENSIONS = ['.gts', '.gjs', '.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '.jsx'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'tmp']);
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];

function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// --- file content, memoised on mtime and size -------------------------------

interface FileRecord {
  mtimeMs: number;
  size: number;
  sha: string;
  imports: string[];
  /** Project files the imports resolve to; filled on first use. */
  edges?: string[];
}
const fileRecords = new Map<string, FileRecord | null>();

function fileRecord(file: string): FileRecord | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    fileRecords.set(file, null);
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
  const record = { mtimeMs: stat.mtimeMs, size: stat.size, sha: sha256(contents), imports: importSpecifiers(contents) };
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
  /** Absolute directory non-relative specifiers resolve against. */
  baseUrl: string | null;
  /** Pattern → absolute target patterns, child config first. */
  paths: Array<[string, string[]]>;
}
const projectPathsByTsconfig = new Map<string, ProjectPaths>();

// tsconfig.json is JSON with comments and trailing commas.
function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && (text[j] !== '"' || text[j - 1] === '\\')) j++;
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
  extends?: string | string[];
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

function readTsconfigChain(tsconfigPath: string, seen = new Set<string>()): ProjectPaths {
  const result: ProjectPaths = { baseUrl: null, paths: [] };
  if (seen.has(tsconfigPath)) return result;
  seen.add(tsconfigPath);
  let config: TsconfigShape;
  try {
    config = parseJsonc(fs.readFileSync(tsconfigPath, 'utf8')) as TsconfigShape;
  } catch {
    return result;
  }
  const dir = path.dirname(tsconfigPath);
  const options = config.compilerOptions ?? {};
  if (options.baseUrl) result.baseUrl = path.resolve(dir, options.baseUrl);
  // `paths` without `baseUrl` resolve relative to the tsconfig that declares them.
  const pathsBase = result.baseUrl ?? dir;
  for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
    result.paths.push([pattern, targets.map((t) => path.resolve(pathsBase, t))]);
  }
  const parents = Array.isArray(config.extends) ? config.extends : config.extends ? [config.extends] : [];
  for (const parent of parents) {
    const parentPath = resolveExtends(parent, dir);
    if (!parentPath) continue;
    const inherited = readTsconfigChain(parentPath, seen);
    result.baseUrl ??= inherited.baseUrl;
    result.paths.push(...inherited.paths);
  }
  return result;
}

function resolveExtends(spec: string, fromDir: string): string | null {
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const abs = path.resolve(fromDir, spec);
    return fs.existsSync(abs) ? abs : fs.existsSync(`${abs}.json`) ? `${abs}.json` : null;
  }
  try {
    return createRequire(path.join(fromDir, 'package.json')).resolve(spec);
  } catch {
    return null;
  }
}

function projectPaths(tsconfigPath: string): ProjectPaths {
  let cached = projectPathsByTsconfig.get(tsconfigPath);
  if (!cached) {
    cached = readTsconfigChain(tsconfigPath);
    projectPathsByTsconfig.set(tsconfigPath, cached);
  }
  return cached;
}

// --- module resolution -----------------------------------------------------------

function probeFile(candidate: string): string | null {
  const stem = candidate.replace(/\.(?:js|mjs|cjs|jsx)$/, '');
  const attempts = [candidate, ...EXTENSIONS.map((ext) => stem + ext), ...EXTENSIONS.map((ext) => path.join(candidate, `index${ext}`))];
  for (const attempt of attempts) {
    try {
      if (fs.statSync(attempt).isFile()) return attempt;
    } catch {
      // next
    }
  }
  return null;
}

function matchPattern(pattern: string, spec: string): string | null {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === spec ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) return null;
  return spec.slice(prefix.length, spec.length - suffix.length);
}

// Resolution is memoised per (importing directory, specifier) for the life
// of the process: the file system is probed once per distinct import. A
// file created later, that an earlier unresolved specifier would now
// reach, is seen after a restart.
const resolutionByKey = new Map<string, string | null>();

/** The project file `spec` refers to from `fromFile`, or null when it is a package or unresolved. */
export function resolveProjectImport(spec: string, fromFile: string, tsconfigPath: string): string | null {
  const memoKey = `${tsconfigPath}\0${path.dirname(fromFile)}\0${spec}`;
  const memo = resolutionByKey.get(memoKey);
  if (memo !== undefined) return memo;
  const resolved = resolveProjectImportUncached(spec, fromFile, tsconfigPath);
  resolutionByKey.set(memoKey, resolved);
  return resolved;
}

function resolveProjectImportUncached(spec: string, fromFile: string, tsconfigPath: string): string | null {
  const projectRoot = path.dirname(tsconfigPath);
  const candidates: string[] = [];
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    candidates.push(path.resolve(path.dirname(fromFile), spec));
  } else {
    const { baseUrl, paths } = projectPaths(tsconfigPath);
    for (const [pattern, targets] of paths) {
      const wildcard = matchPattern(pattern, spec);
      if (wildcard === null) continue;
      candidates.push(...targets.map((t) => t.replace('*', wildcard)));
    }
    if (baseUrl) candidates.push(path.resolve(baseUrl, spec));
  }
  for (const candidate of candidates) {
    const found = probeFile(candidate);
    if (found && found.startsWith(projectRoot + path.sep) && !found.includes(`${path.sep}node_modules${path.sep}`)) {
      return found;
    }
  }
  return null;
}

// --- closure ----------------------------------------------------------------------

/** Project files `file` imports, transitively (absolute paths, sorted, without `file` itself). */
export function dependencyClosure(file: string, contents: string, tsconfigPath: string): string[] {
  const root = path.resolve(file);
  const seen = new Set<string>([root]);
  const resolveAll = (from: string, specs: string[]) =>
    specs.map((spec) => resolveProjectImport(spec, from, tsconfigPath)).filter((dep): dep is string => dep !== null);
  const queue: string[][] = [resolveAll(root, importSpecifiers(contents))];
  while (queue.length > 0) {
    for (const dep of queue.pop()!) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const record = fileRecord(dep);
      if (!record) continue;
      record.edges ??= resolveAll(dep, record.imports);
      queue.push(record.edges);
    }
  }
  seen.delete(root);
  return [...seen].sort();
}

// --- project-wide inputs -------------------------------------------------------

// Ambient declarations reach every file without an import. They and the
// lockfile are hashed once per process, like the tsconfig: a long-lived
// host sees a change to them after a restart.
const ambientFilesByRoot = new Map<string, string[]>();
const projectInputsShaByTsconfig = new Map<string, string>();

function ambientDeclarationFiles(projectRoot: string): string[] {
  let files = ambientFilesByRoot.get(projectRoot);
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
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.d.ts')) {
        files!.push(path.join(dir, entry.name));
      }
    }
  };
  walk(projectRoot);
  files.sort();
  ambientFilesByRoot.set(projectRoot, files);
  return files;
}

function projectInputsSha(tsconfigPath: string): string {
  const memo = projectInputsShaByTsconfig.get(tsconfigPath);
  if (memo !== undefined) return memo;
  const projectRoot = path.dirname(tsconfigPath);
  const hash = crypto.createHash('sha256');
  for (const file of [...ambientDeclarationFiles(projectRoot), ...LOCKFILES.map((name) => path.join(projectRoot, name))]) {
    const record = fileRecord(file);
    if (!record) continue;
    hash.update(path.relative(projectRoot, file));
    hash.update(record.sha);
    hash.update('\0');
  }
  const sha = hash.digest('hex');
  projectInputsShaByTsconfig.set(tsconfigPath, sha);
  return sha;
}

/**
 * Sha over everything `file`'s type information can depend on besides its
 * own content: the content of its import closure, the project's ambient
 * `.d.ts` files and its lockfile.
 */
export function dependencySha(file: string, contents: string, tsconfigPath: string | null): string {
  if (!tsconfigPath) return 'no-tsconfig';
  const projectRoot = path.dirname(tsconfigPath);
  const hash = crypto.createHash('sha256');
  for (const dep of dependencyClosure(file, contents, tsconfigPath)) {
    const record = fileRecord(dep);
    if (!record) continue;
    hash.update(path.relative(projectRoot, dep));
    hash.update(record.sha);
    hash.update('\0');
  }
  hash.update(projectInputsSha(tsconfigPath));
  return hash.digest('hex');
}
