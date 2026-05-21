// Find a component's template content given a declaration site.
//
// One function with one job. Replaces:
//   - lib/component-attrs.ts:extractTemplateContent / parseGtsFile / readJs*
//   - lib/glint.ts:resolveGtsPath / resolveGtsPathForPolymorphic
//   - lib/glint.ts:resolveAddonHbsTemplate
//   - lib/outer-wrapper-resolver.ts:resolveLocalImport (file-resolution part)
//   - lib/classic-resolver.ts:findClassicComponent / tryProbeAddon
//
// Resolution paths (tried in order):
//   1. .gts/.gjs source: content-tag → template content
//   2. .hbs source: read directly
//   3. .d.ts declaration: bridge to companion source via the package's
//      `exports` map. The same subpath that resolved to the .d.ts
//      under "types" tells us where "default"/"import" points (the
//      compiled .js). We extract the template content from the .js
//      via TS-parser walk for `precompileTemplate(...)` /
//      `template(...)` (RFC 0931). When the package also ships .gts
//      source alongside (HDS pattern), we prefer that over .js.
//   4. Classic v1-addon by-name lookup: walk the consumer's package
//      dependencies (via @embroider/shared-internals.PackageCache),
//      probe addons for `addon/templates/components/<kebab>.hbs` etc.
//
// Caching: per-process, keyed by absolute origin path. Process-
// lifetime; no invalidation. Test code can call `_clearCache`.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Preprocessor } from 'content-tag';
import type * as TS from 'typescript';
// `@embroider/shared-internals` is lazy-imported via `loadEmbroider`
// below — it's a 344KB dep (plus lodash, fs-extra, resolve-package-path,
// etc. transitively) and importing it eagerly at module-load time
// noticeably slowed VS Code's html-validate language-server startup +
// teardown after we picked it up in 0.4.2. Only the v1-addon by-name
// lookup path needs it; most validations never touch that path.
type PackageCache = {
  ownerOfFile: (file: string) => Package | null | undefined;
  get: (pkgRoot: string) => Package;
};
type PackageCacheCtor = {
  shared(appOrAddonName: string, basedir: string): PackageCache;
};
type Package = {
  root: string;
  isEmberAddon: () => boolean;
  packageJSON: { name?: string; exports?: unknown };
};

const preprocessor = new Preprocessor();

export interface TemplateSource {
  /** Glimmer template content (suitable for @glimmer/syntax preprocess). */
  content: string;
  /** Origin file path — for diagnostics + downstream class-body lookup. */
  origin: string;
  /** Origin file kind. `.gts/.gjs` and `.hbs` allow class-body inspection
   *  in the same file; `.js`/`.d.ts` typically require a sibling lookup. */
  kind: 'gts' | 'gjs' | 'hbs' | 'js';
}

export interface FindOptions {
  /** Declaration site Glint resolved (often .d.ts in cross-package). */
  declFile?: string | null;
  /** Byte range of the declaration within declFile. Used to pick the
   *  matching `<template>` block in multi-template `.gts` files (e.g.
   *  files containing multiple `const X = <template>…</template>;`). */
  declRange?: { start: number; end: number } | null;
  /** PascalCase component name from the consumer template (e.g. `MyButton`).
   *  Required for v1-addon by-name lookup; ignored otherwise. */
  componentName?: string | null;
  /** Consumer file (for v1-addon by-name lookup, walks up to its package). */
  consumerFile?: string | null;
  /** TypeScript module (for compiled-.js extraction). When absent, the
   *  .js path returns null. */
  ts?: typeof TS | null;
}

const cache = new Map<string, TemplateSource | null>();

export function findTemplateSource(opts: FindOptions): TemplateSource | null {
  const { declFile, declRange, componentName, consumerFile, ts } = opts;

  if (declFile) {
    // Cache key folds in componentName + declRange so repeated
    // invocations of the same component in one extraction run reuse
    // the parsed template instead of re-reading + re-parsing the file
    // each time. Multi-template targets need name/range to pick the
    // right `<template>` block, so those hints must distinguish cache
    // entries that point at the same file but resolve to different
    // blocks.
    const rangeKey = declRange ? `${declRange.start},${declRange.end}` : '';
    const cacheKey = `decl:${declFile}\0${componentName ?? ''}\0${rangeKey}`;
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey)!;
      if (cached) return cached;
    } else {
      const result = findFromDecl(declFile, ts ?? null, declRange ?? null, componentName ?? null);
      cache.set(cacheKey, result);
      if (result) return result;
    }
  }

  if (consumerFile && componentName) {
    const cacheKey = `import:${consumerFile}\0${componentName}`;
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey)!;
      if (cached) return cached;
    } else {
      const importedFile = resolveImport(consumerFile, componentName, ts ?? null);
      const result = importedFile ? findFromImport(importedFile, componentName, ts ?? null) : null;
      cache.set(cacheKey, result);
      if (result) return result;
    }

    const byNameKey = `byname:${path.dirname(consumerFile)}\0${componentName}`;
    if (cache.has(byNameKey)) return cache.get(byNameKey)!;
    const result = findByName(consumerFile, componentName);
    cache.set(byNameKey, result);
    if (result) return result;
  }

  return null;
}

// Follow an import to its template source. The resolved file may be:
//   - .gts/.gjs/.hbs/.js/.d.ts → load directly via findFromDecl.
//   - .ts barrel: look for `export { default as <componentName> } from './path'`
//     and recurse (depth-capped to avoid pathological barrel chains).
function findFromImport(
  resolvedFile: string,
  componentName: string,
  ts: typeof TS | null,
  depth = 0,
): TemplateSource | null {
  if (depth >= 10) return null;
  const direct = findFromDecl(resolvedFile, ts, null, componentName);
  if (direct) return direct;
  // Barrel walk: only for .ts/.js. Look for re-exports of componentName.
  if (!ts) return null;
  if (!resolvedFile.endsWith('.ts') && !resolvedFile.endsWith('.js')) return null;
  let contents: string;
  try {
    contents = fs.readFileSync(resolvedFile, 'utf8');
  } catch {
    return null;
  }
  const sf = ts.createSourceFile(
    resolvedFile,
    contents,
    ts.ScriptTarget.Latest,
    false,
    resolvedFile.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
    for (const elem of stmt.exportClause.elements) {
      // `export { X as Y }` → name = Y, propertyName = X
      // `export { X }` → name = X, propertyName undefined
      // `export { default as Y }` → name = Y, propertyName = 'default'
      if (elem.name.text !== componentName) continue;
      const innerName = elem.propertyName?.text ?? elem.name.text;
      const next = resolveModuleSpec(resolvedFile, stmt.moduleSpecifier.text);
      if (!next) continue;
      // Recurse: resolve the chain. For named imports we use the
      // inner name; for `export { default as Y } from './path'` we
      // propagate the barrel-side alias (`componentName`). In both
      // cases the recursion goes back through `findFromImport` so
      // multi-level barrel chains (HDS-style nested re-exports)
      // continue to walk — `findFromImport`'s first step (`findFromDecl`)
      // handles the leaf `.gts`/`.gjs`/`.d.ts` case, and its barrel-
      // walk loop handles the chained-barrel case.
      const target = innerName === 'default' ? componentName : innerName;
      const result = findFromImport(next, target, ts, depth + 1);
      if (result) return result;
    }
  }
  return null;
}

// --- decl-driven resolution ----------------------------------------------

function findFromDecl(
  declFile: string,
  ts: typeof TS | null,
  declRange: { start: number; end: number } | null,
  componentName: string | null,
): TemplateSource | null {
  if (declFile.endsWith('.gts')) return readGts(declFile, 'gts', declRange, componentName);
  if (declFile.endsWith('.gjs')) return readGts(declFile, 'gjs', declRange, componentName);
  if (declFile.endsWith('.hbs')) return readHbs(declFile);

  if (declFile.endsWith('.d.ts')) {
    return findFromDeclaration(declFile, ts);
  }

  if (declFile.endsWith('.js')) {
    if (ts) {
      const content = extractCompiledJs(declFile, ts);
      if (content !== null) return { content, origin: declFile, kind: 'js' };
    }
    return tryHbsPeer(declFile);
  }
  if (declFile.endsWith('.ts')) {
    // Glint lays a virtual `.ts` shadow alongside its `.gts`/`.gjs`
    // source. Map back so we read the original Glimmer templates.
    // We deliberately drop `declRange` here (TS positions in the
    // shadow don't match content-tag positions in the .gts when
    // Glint's emit prepends imports — see findDeclRangeByName for
    // the name-based fallback that operates entirely in .gts coords).
    const base = declFile.slice(0, -'.ts'.length);
    for (const ext of ['.gts', '.gjs'] as const) {
      const candidate = base + ext;
      if (fs.existsSync(candidate)) {
        return readGts(candidate, ext.slice(1) as 'gts' | 'gjs', null, componentName);
      }
    }
    return tryHbsPeer(declFile);
  }

  return null;
}

function readGts(
  file: string,
  kind: 'gts' | 'gjs',
  declRange: { start: number; end: number } | null = null,
  componentName: string | null = null,
): TemplateSource | null {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let blocks: ReturnType<Preprocessor['parse']>;
  try {
    blocks = preprocessor.parse(contents, { filename: file });
  } catch {
    return null;
  }
  const templates = blocks.filter((b) => b.tagName === 'template');
  if (templates.length === 1) {
    return { content: templates[0]!.contents, origin: file, kind };
  }
  if (templates.length === 0) return null;

  // Multi-template file. We need to pick the template that belongs to
  // the resolving declaration. Two candidate routes:
  //
  //  1. componentName + .gts coord-range: parse the .gts with templates
  //     stripped (whitespace-padded by content-tag) to get TS-parseable
  //     content in .gts coordinates, find the named declaration, use
  //     its .gts-coord range. Robust against Glint's TS-emit preamble
  //     shifting positions.
  //
  //  2. declRange (fallback): TS's `decl.getStart()/getEnd()`. Works
  //     when no preamble shift exists, but fails on multi-template
  //     class files where Glint inserts hundreds of chars of imports.
  let resolvedRange: { start: number; end: number } | null = null;
  if (componentName) {
    resolvedRange = findDeclRangeByName(contents, file, blocks, componentName);
  }
  if (!resolvedRange && declRange) {
    resolvedRange = declRange;
  }
  if (!resolvedRange) return null;

  for (const block of templates) {
    if (!block.range) continue;
    const start = block.range.startUtf16Codepoint;
    const end = block.range.endUtf16Codepoint;
    if (start >= resolvedRange.start && end <= resolvedRange.end) {
      return { content: block.contents, origin: file, kind };
    }
  }
  return null;
}

// Strip template blocks to whitespace + TS-parse the result. content-tag
// preserves source positions, so the parsed AST gives ranges in the
// .gts coordinate system. Find a declaration whose name matches and
// return its range.
function findDeclRangeByName(
  contents: string,
  file: string,
  blocks: ReturnType<Preprocessor['parse']>,
  componentName: string,
): { start: number; end: number } | null {
  let buf = contents;
  for (const block of [...blocks].reverse()) {
    if (block.tagName !== 'template') continue;
    if (!block.range) continue;
    // JS strings are UTF-16-codepoint indexed; content-tag's `startByte`
    // diverges from `startUtf16Codepoint` on multibyte content. Use the
    // codepoint offsets for `String.prototype.slice`.
    const start = block.range.startUtf16Codepoint;
    const end = block.range.endUtf16Codepoint;
    buf = buf.slice(0, start) + ' '.repeat(end - start) + buf.slice(end);
  }
  let ts: typeof TS;
  try {
    ts = localRequire(file, 'typescript') as typeof TS;
  } catch {
    return null;
  }
  const sf = ts.createSourceFile(file, buf, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let result: { start: number; end: number } | null = null;
  function visit(node: TS.Node): void {
    if (result) return;
    if (ts.isClassDeclaration(node) && node.name && node.name.text === componentName) {
      result = { start: node.getStart(), end: node.getEnd() };
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === componentName) {
          result = { start: node.getStart(), end: node.getEnd() };
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}

function localRequire(fromFile: string, moduleName: string): unknown {
  return createRequire(fromFile)(moduleName);
}

function readHbs(file: string): TemplateSource | null {
  try {
    return { content: fs.readFileSync(file, 'utf8'), origin: file, kind: 'hbs' };
  } catch {
    return null;
  }
}

// .ts/.js with .hbs colocation: classic Ember pattern.
//   addon/components/foo.ts  +  addon/templates/components/foo.hbs
//   app/components/foo.js    +  app/templates/components/foo.hbs
function tryHbsPeer(file: string): TemplateSource | null {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/\.(ts|js)$/, '');
  const sibling = path.join(dir, `${base}.hbs`);
  if (fs.existsSync(sibling)) return readHbs(sibling);

  const m = /^(.*)\/components\/(.+)\.(ts|js)$/.exec(file);
  if (m) {
    const [, prefix, name] = m;
    const peer = path.join(prefix!, 'templates', 'components', `${name}.hbs`);
    if (fs.existsSync(peer)) return readHbs(peer);
  }
  return null;
}

// --- .d.ts → companion source bridge -------------------------------------
//
// Strategy:
//   1. PackageCache.ownerOfFile(declFile) gives us the addon Package.
//   2. The package's `exports` map matches subpaths to (types, default).
//   3. Find the subpath whose `types` entry equals declFile (relative to
//      package root). Read the corresponding `default`/`import` to get
//      the .js path.
//   4. .gts companion: addons that ship source alongside (HDS) place it
//      at a sibling location. Try common patterns: `src/X.gts`,
//      `addon/X.gts`. Path-derived from declFile by replacing the
//      "types directory" segment.
//
// PackageCache replaces the hand-rolled `node_modules`/`isEmberAddon`
// scan in classic-resolver.ts.

function findFromDeclaration(declFile: string, ts: typeof TS | null): TemplateSource | null {
  const pkg = packageOwnerOf(declFile);
  if (!pkg) return null;

  // Authoritative: addon's `exports` map. The same subpath whose
  // `types` resolves to declFile tells us where `default`/`import`
  // points — that's the runtime source of truth.
  const companion = findCompanionViaExports(declFile, pkg);
  if (companion) {
    const result = loadFromCompanion(companion, ts);
    if (result) return result;
  }

  // Fallback: addons that ship .gts source alongside .d.ts but don't
  // expose it via `exports` (HDS pattern). Path-replace within the
  // package root.
  const fallback = findGtsCompanion(declFile, pkg);
  if (fallback) {
    return readGts(fallback, fallback.endsWith('.gjs') ? 'gjs' : 'gts');
  }

  return null;
}

function loadFromCompanion(companion: string, ts: typeof TS | null): TemplateSource | null {
  if (companion.endsWith('.gts')) return readGts(companion, 'gts');
  if (companion.endsWith('.gjs')) return readGts(companion, 'gjs');
  if (companion.endsWith('.hbs')) return readHbs(companion);
  if (companion.endsWith('.js') && ts) {
    const content = extractCompiledJs(companion, ts);
    if (content !== null) return { content, origin: companion, kind: 'js' };
  }
  return null;
}

function findGtsCompanion(declFile: string, pkg: Package): string | null {
  const rel = path.relative(pkg.root, declFile);
  if (rel.startsWith('..')) return null;
  const candidates = [
    rel.replace(/^declarations\//, 'src/').replace(/\.d\.ts$/, '.gts'),
    rel.replace(/^declarations\//, 'src/').replace(/\.d\.ts$/, '.gjs'),
    rel.replace(/^dist\/types\//, 'src/').replace(/\.d\.ts$/, '.gts'),
    rel.replace(/^dist\/types\//, 'src/').replace(/\.d\.ts$/, '.gjs'),
  ];
  for (const cand of candidates) {
    if (cand === rel) continue;
    const abs = path.join(pkg.root, cand);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function findCompanionViaExports(declFile: string, pkg: Package): string | null {
  const exportsMap = pkg.packageJSON?.exports as unknown;
  if (exportsMap == null || typeof exportsMap !== 'object') return null;
  const relDecl = './' + path.relative(pkg.root, declFile).replace(/\\/g, '/');

  for (const [subpath, conditions] of Object.entries(exportsMap as Record<string, unknown>)) {
    if (typeof conditions !== 'object' || conditions === null) continue;
    const types = (conditions as Record<string, unknown>)['types'];
    if (typeof types !== 'string') continue;
    const def = (conditions as Record<string, unknown>)['default']
      ?? (conditions as Record<string, unknown>)['import']
      ?? (conditions as Record<string, unknown>)['require'];
    if (typeof def !== 'string') continue;

    if (subpath.includes('*')) {
      const wildcardValue = matchWildcardPattern(types, relDecl);
      if (wildcardValue !== null) {
        const abs = withinPackage(pkg.root, def.replace('*', wildcardValue));
        if (abs && fs.existsSync(abs)) return abs;
      }
    } else if (types === relDecl) {
      const abs = withinPackage(pkg.root, def);
      if (abs && fs.existsSync(abs)) return abs;
    }
  }
  return null;
}

// Resolve an exports target (untrusted — from a dependency's
// package.json) against the package root, returning the absolute path
// only if it stays within the root. Guards against absolute paths and
// `..` segments escaping the package directory.
function withinPackage(pkgRoot: string, target: string): string | null {
  const baseDir = path.resolve(pkgRoot);
  const abs = path.resolve(pkgRoot, target);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return null;
  return abs;
}

// Pattern `./declarations/*.d.ts` against `./declarations/foo/bar.d.ts` → 'foo/bar'.
// `*` matches one or more path segments (Node exports-map semantics).
function matchWildcardPattern(pattern: string, candidate: string): string | null {
  const idx = pattern.indexOf('*');
  if (idx < 0) return null;
  const prefix = pattern.slice(0, idx);
  const suffix = pattern.slice(idx + 1);
  if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) return null;
  return candidate.slice(prefix.length, candidate.length - suffix.length);
}

// --- compiled .js extraction --------------------------------------------

function extractCompiledJs(file: string, ts: typeof TS): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const sf = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const found: string[] = [];
  function visit(node: TS.Node): void {
    if (found.length > 1) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
          ? callee.name.text
          : null;
      if (name === 'precompileTemplate' || name === 'template') {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          found.push(arg.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found.length === 1 ? found[0]! : null;
}

// --- v1-addon by-name lookup --------------------------------------------
//
// Classic Ember resolves PascalCase to kebab-case and looks up
// `addon/templates/components/<kebab>.hbs` under any installed addon.
// Walk consumer's parent directories for node_modules; for each
// candidate package, use PackageCache.get to classify it as an Ember
// addon (replaces hand-rolled isEmberAddon detection).

function findByName(consumerFile: string, componentName: string): TemplateSource | null {
  const kebab = pascalToKebab(componentName);
  const cache = getCache();
  // No `@embroider/shared-internals` available — by-name v1-addon
  // lookup needs PackageCache to classify addons; without it we can't
  // safely probe arbitrary node_modules entries.
  if (!cache) return null;

  let dir = path.dirname(consumerFile);
  for (;;) {
    const nodeModules = path.join(dir, 'node_modules');
    if (fs.existsSync(nodeModules)) {
      const hit = probeNodeModules(cache, nodeModules, kebab);
      if (hit) return hit;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function probeNodeModules(cache: PackageCache, nodeModules: string, kebab: string): TemplateSource | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    if (entry.name.startsWith('@')) {
      const scoped = probeScopedDir(cache, path.join(nodeModules, entry.name), kebab);
      if (scoped) return scoped;
      continue;
    }
    const hit = tryAddonProbe(cache, path.join(nodeModules, entry.name), kebab);
    if (hit) return hit;
  }
  return null;
}

function probeScopedDir(cache: PackageCache, scopeDir: string, kebab: string): TemplateSource | null {
  let scoped: fs.Dirent[];
  try {
    scoped = fs.readdirSync(scopeDir, { withFileTypes: true });
  } catch {
    return null;
  }
  scoped.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of scoped) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const hit = tryAddonProbe(cache, path.join(scopeDir, entry.name), kebab);
    if (hit) return hit;
  }
  return null;
}

function tryAddonProbe(cache: PackageCache, pkgRoot: string, kebab: string): TemplateSource | null {
  let pkg: Package | undefined;
  try {
    pkg = cache.get(pkgRoot);
  } catch {
    return null;
  }
  if (!pkg.isEmberAddon()) return null;
  for (const sub of [
    `addon/templates/components/${kebab}.hbs`,
    `app/components/${kebab}.hbs`,
    `addon/components/${kebab}.hbs`,
  ]) {
    const abs = path.join(pkg.root, sub);
    if (fs.existsSync(abs)) return readHbs(abs);
  }
  return null;
}

function pascalToKebab(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

// --- PackageCache helpers ------------------------------------------------

let sharedCache: PackageCache | null = null;
let embroiderModule: { PackageCache: PackageCacheCtor } | null | undefined;

// Lazy import. Eagerly requiring `@embroider/shared-internals` at
// module load (its 344KB JS + transitive lodash / fs-extra /
// resolve-package-path / babel-import-util) showed up as noticeable
// VS Code html-validate language-server startup + shutdown lag in
// 0.4.2. Only the v1-addon by-name lookup path actually needs it,
// so defer until the first `getCache()` call — projects with no v1
// addons (or whose resolver never falls through to by-name) skip
// the load entirely.
function loadEmbroider(): { PackageCache: PackageCacheCtor } | null {
  if (embroiderModule !== undefined) return embroiderModule;
  try {
    embroiderModule = createRequire(import.meta.url)('@embroider/shared-internals') as {
      PackageCache: PackageCacheCtor;
    };
  } catch {
    embroiderModule = null;
  }
  return embroiderModule;
}

function getCache(): PackageCache | null {
  // PackageCache.shared keys by ('appOrAddonName', basedir). We're not
  // an app — we're a plugin reading other people's packages. The
  // identifier just needs to be stable within a process.
  if (!sharedCache) {
    const embroider = loadEmbroider();
    if (!embroider) return null;
    sharedCache = embroider.PackageCache.shared('html-validate-ember', process.cwd());
  }
  return sharedCache;
}

function packageOwnerOf(file: string): Package | null {
  const cache = getCache();
  if (!cache) return null;
  try {
    return cache.ownerOfFile(file) ?? null;
  } catch {
    return null;
  }
}

// --- import resolution ---------------------------------------------------
//
// Given an origin file (.gts/.gjs/.js/.ts), find the file that
// `componentName` resolves to via that file's imports. Used by the
// canonical resolver for PascalCase wrapper recursion.
//
// Default imports: `import Foo from './foo.js';` → './foo.js' resolved
// relative to origin.
// Named imports: `import { Foo } from 'pkg';` → 'pkg' resolved via
// Node module resolution (createRequire from origin).
//
// Returns absolute path to the imported file, or null when:
//   - The component isn't imported.
//   - The import target can't be resolved.
//   - origin is .hbs (no imports — handled by by-name lookup).

export function resolveImport(
  originFile: string,
  componentName: string,
  ts: typeof TS | null,
): string | null {
  if (!ts) return null;
  if (originFile.endsWith('.hbs')) return null;

  let scriptContents: string;
  try {
    scriptContents = fs.readFileSync(originFile, 'utf8');
  } catch {
    return null;
  }
  if (originFile.endsWith('.gts') || originFile.endsWith('.gjs')) {
    // Strip <template> blocks before TS parsing — TS doesn't speak
    // <template>-as-expression syntax.
    try {
      const blocks = preprocessor.parse(scriptContents, { filename: originFile });
      let buf = scriptContents;
      for (const block of [...blocks].reverse()) {
        if (block.tagName !== 'template') continue;
        const r = block.range;
        if (!r) continue;
        const start = r.startUtf16Codepoint;
        const end = r.endUtf16Codepoint;
        buf = buf.slice(0, start) + ' '.repeat(end - start) + buf.slice(end);
      }
      scriptContents = buf;
    } catch {
      return null;
    }
  }

  const sf = ts.createSourceFile(
    originFile,
    scriptContents,
    ts.ScriptTarget.Latest,
    false,
    originFile.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!stmt.importClause) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;

    if (matchesImport(ts, stmt.importClause, componentName)) {
      return resolveModuleSpec(originFile, stmt.moduleSpecifier.text);
    }
  }
  return null;
}

function matchesImport(
  ts: typeof TS,
  clause: TS.ImportClause,
  componentName: string,
): boolean {
  if (clause.name && clause.name.text === componentName) return true;
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const elem of clause.namedBindings.elements) {
      if (elem.name.text === componentName) return true;
    }
  }
  return false;
}

function resolveModuleSpec(originFile: string, spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const dir = path.dirname(originFile);
    for (const candidate of [
      spec,
      `${spec}.js`,
      `${spec}.ts`,
      `${spec}.gts`,
      `${spec}.gjs`,
      `${spec}.d.ts`,
    ]) {
      const abs = path.resolve(dir, candidate);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    }
    return null;
  }
  // Bare specifier: prefer Node's resolver. When Node resolution fails
  // (common with v2-addons that ship source-only — `dist/` and
  // `declarations/` don't exist on disk for in-development monorepo
  // setups), fall back to direct-source probing under `<pkg>/src/`.
  try {
    return createRequire(originFile).resolve(spec);
  } catch {
    return resolveBareSpecToSource(originFile, spec);
  }
}

function resolveBareSpecToSource(originFile: string, spec: string): string | null {
  // Split spec into pkg name + subpath.
  // Scoped: `@scope/pkg/path/to/file` — pkg = '@scope/pkg', sub = 'path/to/file'.
  // Unscoped: `pkg/path/to/file` — pkg = 'pkg', sub = 'path/to/file'.
  const segments = spec.split('/');
  let pkgName: string;
  let subpath: string;
  if (spec.startsWith('@')) {
    if (segments.length < 2) return null;
    pkgName = `${segments[0]}/${segments[1]}`;
    subpath = segments.slice(2).join('/');
  } else {
    pkgName = segments[0]!;
    subpath = segments.slice(1).join('/');
  }
  // Walk up from origin to find node_modules/<pkgName>.
  let dir = path.dirname(originFile);
  for (;;) {
    const pkgRoot = path.join(dir, 'node_modules', pkgName);
    if (fs.existsSync(pkgRoot)) {
      // Built package: resolve the subpath through the `exports` map and
      // probe extensions. Node's resolver (require.resolve, tried first
      // by the caller) rejects extensionless subpath-pattern targets
      // like `"./*": { "default": "./dist/*" }` — ESM exports don't
      // auto-append `.js`. A built v2-addon (HDS-style: `dist/` present,
      // `src/` stripped by its `files` allowlist) would otherwise fail
      // to resolve here, dropping the template-override and letting
      // Glint's splatted `Element` tag win → `element-permitted-content`
      // false positives.
      const viaExports = resolveSubpathViaExports(pkgRoot, subpath);
      if (viaExports) return viaExports;
      // Source-only package (in-development monorepo): `dist/` absent,
      // `src/` present.
      for (const ext of ['.ts', '.gts', '.gjs', '.js', '.d.ts']) {
        const candidate = path.join(pkgRoot, 'src', subpath + ext);
        if (fs.existsSync(candidate)) return candidate;
      }
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolve a package subpath through its `exports` map to an on-disk
// file, probing extensions. Handles extensionless subpath-pattern
// targets (`"./*": { "default": "./dist/*" }`) that Node's exports
// resolver rejects. Prefers the runtime condition (default/import/
// require): the compiled `.js` carries the template inline via
// `precompileTemplate(...)` / `template(...)`.
function resolveSubpathViaExports(pkgRoot: string, subpath: string): string | null {
  let exportsMap: unknown;
  try {
    exportsMap = (
      JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
        exports?: unknown;
      }
    ).exports;
  } catch {
    return null;
  }
  if (exportsMap == null || typeof exportsMap !== 'object') return null;
  const relImport = subpath ? './' + subpath : '.';
  // Pick the MOST SPECIFIC matching entry, mirroring Node's exports
  // resolution: an exact subpath beats any pattern, and among `*`
  // patterns the one with the longest static prefix wins. First-match-
  // in-object-order would mis-resolve a package with overlapping entries
  // (e.g. `"./components/*"` alongside `"./*"`).
  let bestTarget: string | null = null;
  let bestScore = -1;
  for (const [pattern, conditions] of Object.entries(exportsMap as Record<string, unknown>)) {
    if (typeof conditions !== 'object' || conditions === null) continue;
    const c = conditions as Record<string, unknown>;
    const target = c['default'] ?? c['import'] ?? c['require'];
    if (typeof target !== 'string') continue;
    let resolved: string | null = null;
    let score = -1;
    if (pattern === relImport) {
      resolved = target;
      score = Infinity; // exact match always wins
    } else if (pattern.includes('*')) {
      const wild = matchWildcardPattern(pattern, relImport);
      if (wild !== null) {
        resolved = target.replace('*', wild);
        score = pattern.indexOf('*'); // longer static prefix = more specific
      }
    }
    if (resolved !== null && score > bestScore) {
      bestScore = score;
      bestTarget = resolved;
    }
  }
  if (bestTarget === null) return null;
  for (const ext of ['', '.js', '.gts', '.gjs', '.ts', '.d.ts']) {
    const abs = withinPackage(pkgRoot, bestTarget + ext);
    if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

// --- test hook -----------------------------------------------------------

export function _clearCache(): void {
  cache.clear();
  sharedCache = null;
}
