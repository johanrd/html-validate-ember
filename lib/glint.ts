// Optional Glint integration. When @glint/ember-tsc is installed in the host
// project, we use it to extract TypeScript type information for attribute-
// value mustache positions. The transformer's static-text resolver then sees
// `popover={{@mode}}` (where `@mode: 'auto' | 'manual' | 'hint'` from the
// component's Signature) as a string-literal-union and embeds one of the
// values, letting html-validate's enum rules apply.
//
// When @glint/ember-tsc is absent: all functions return null and the
// transformer falls back to its non-Glint static-resolution path.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';

import { isNativeTag } from '../blank.js';
import { getSplattedRootsForFile, extractSplattedRootFromTemplate } from './component-attrs.js';
import type { ComponentAttrs } from './builtin-components.js';
import { readCache, writeCache } from './cache.js';
import type { AttrTypeInfo, ExtractionResult } from './cache.js';

// Minimal local typing for the @glint/ember-tsc API surface we use.
// Avoids importing types from @glint/ember-tsc (an optional peerDep)
// into our shipped .d.ts, which would force downstream consumers to
// install Glint just to read our types.
interface GlintEnvironment {
  // We treat as opaque — passed through to rewriteModule.
}
interface GlintConfig {
  environment: GlintEnvironment;
}
interface GlintRewriteResult {
  transformedContents: string;
  correlatedSpans: Array<{
    glimmerAstMapping?: GlimmerAstMappingNode | undefined;
    transformedStart: number;
  }>;
}
interface GlimmerAstMappingNode {
  sourceNode?: {
    type?: string;
    loc?: { start: { line: number; column: number } };
    tag?: string;
  };
  parent?: { sourceNode?: { type?: string; tag?: string; loc?: { start: { line: number; column: number } } } };
  transformedRange?: { start: number; end: number };
  children?: GlimmerAstMappingNode[];
}
interface GlintDeps {
  ts: typeof TS;
  rewriteModule(
    ts: typeof TS,
    script: { script: { filename: string; contents: string } },
    environment: GlintEnvironment,
  ): GlintRewriteResult | null;
  createDefaultConfig(ts: typeof TS, projectRoot: string): GlintConfig;
}

// Cache deps per project root — `createRequire` resolves @glint/ember-tsc
// from the project's installed packages, not ours. This means
// `html-validate-ember` doesn't ship Glint as a runtime dep; if the
// consumer wants Glint integration, they install `@glint/ember-tsc`
// themselves.
//
// Module-level state — `depsByRoot` and `programByTsconfig` (below) are
// shared across calls in the same Node process. Safe under the
// single-threaded CLI / Node main-thread assumption; would need
// per-thread isolation if ever invoked concurrently from worker_threads.
const depsByRoot = new Map<string, GlintDeps | null>();

function loadDeps(filename: string): GlintDeps | null {
  const projectReq = createRequire(path.resolve(filename));
  let glintPath: string;
  try {
    glintPath = projectReq.resolve('@glint/ember-tsc');
  } catch {
    return null;
  }
  const projectRoot = path.dirname(glintPath);
  const cached = depsByRoot.get(projectRoot);
  if (cached !== undefined) {
    return cached;
  }
  let deps: GlintDeps | null;
  try {
    const ts = projectReq('typescript') as typeof TS;
    const transform = projectReq('@glint/ember-tsc/transform/index') as {
      rewriteModule: GlintDeps['rewriteModule'];
    };
    const config = projectReq('@glint/ember-tsc') as {
      createDefaultConfig: GlintDeps['createDefaultConfig'];
    };
    deps = {
      ts,
      rewriteModule: transform.rewriteModule,
      createDefaultConfig: config.createDefaultConfig,
    };
  } catch {
    deps = null;
  }
  depsByRoot.set(projectRoot, deps);
  return deps;
}

interface ProgramContext {
  deps: GlintDeps;
  ts: typeof TS;
  parsed: TS.ParsedCommandLine;
  projectRoot: string;
  virtualFiles: Map<string, string>;
  compilerHost: TS.CompilerHost;
  program: TS.Program | null;
  tsconfigPath: string;
  extraRootNames: string[];
  lastRootKey?: string;
  elementTypeToTag?: Map<string, string>;
}

// One TS program per tsconfig. Lazily built on first request, then reused
// for every file under that tsconfig.
const programByTsconfig = new Map<string, ProgramContext>();

function findTsconfig(start: string): string | null {
  let dir = fs.statSync(start).isDirectory() ? start : path.dirname(start);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function getProgramContext(tsconfigPath: string, deps: GlintDeps): ProgramContext | null {
  const existing = programByTsconfig.get(tsconfigPath);
  if (existing) {
    return existing;
  }
  const { ts } = deps;
  const projectRoot = path.dirname(tsconfigPath);
  const tsconfigSrc = ts.readConfigFile(tsconfigPath, ts.sys.readFile).config as unknown;
  const parsed = ts.parseJsonConfigFileContent(tsconfigSrc, ts.sys, projectRoot);

  // TypeScript's `types` compiler option uses legacy resolution — it doesn't
  // consult package.json `exports` for path-style names like
  // `@glint/ember-tsc/types`. We resolve those via Node's import resolver
  // (which DOES honor exports) and add them to rootNames so the type defs
  // are loaded into the program. Skip what doesn't resolve (likely a
  // virtual-module type that only exists at build time).
  const projectReq = createRequire(path.resolve(projectRoot, 'package.json'));
  const extraRootNames: string[] = [];
  const remainingTypes: string[] = [];
  for (const t of parsed.options.types ?? []) {
    try {
      let resolved = projectReq.resolve(t);
      // Node resolution returns the `.js` entry. TS's `types` option needs a
      // `.d.ts`. Look for the sibling .d.ts (the canonical layout in modern
      // packages: `dist/index.js` + `dist/index.d.ts`).
      if (resolved.endsWith('.js')) {
        const sibling = resolved.slice(0, -3) + '.d.ts';
        if (fs.existsSync(sibling)) {
          resolved = sibling;
        }
      }
      if (resolved.endsWith('.d.ts') || resolved.endsWith('.ts')) {
        extraRootNames.push(resolved);
        continue;
      }
    } catch {
      // not resolvable — drop it from types so TS doesn't warn
    }
    remainingTypes.push(t);
  }
  parsed.options.types = remainingTypes;

  // virtualFiles: file path (.ts shadow OR .gts directly) → rewritten
  // contents. TS may ask for either path depending on how the import was
  // written in source (`from './foo'` → tries `.ts`; `from './foo.gts'`
  // → asks for `.gts` directly via our `resolveModuleNameLiterals` shim).
  const virtualFiles = new Map<string, string>();

  const ctx: ProgramContext = {
    deps,
    ts,
    parsed,
    projectRoot,
    virtualFiles,
    // Filled in below — declare the property up front so we can reference
    // `ctx` inside the host shim closures without TS complaining.
    compilerHost: undefined as unknown as TS.CompilerHost,
    program: null,
    tsconfigPath,
    extraRootNames,
  };

  // For an arbitrary path requested by TS module resolution, return the
  // corresponding `.gts` or `.gjs` source path that should be rewritten
  // and served as the file's content. Three cases:
  //   - Path ends in `.gts` / `.gjs` — return it directly (TS asked for
  //     the literal extension via `resolveModuleNameLiterals`).
  //   - Path ends in `.ts` (and not `.d.ts`) — return sibling `.gts` or
  //     `.gjs` if either exists. Catches imports written without an
  //     extension that TS resolves through `.ts` lookups.
  function gtsForRequest(reqPath: string): string | null {
    if (reqPath.endsWith('.gts') || reqPath.endsWith('.gjs')) {
      return fs.existsSync(reqPath) ? reqPath : null;
    }
    if (reqPath.endsWith('.ts') && !reqPath.endsWith('.d.ts')) {
      const base = reqPath.slice(0, -3);
      for (const ext of ['.gts', '.gjs']) {
        const candidate = base + ext;
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  const compilerHost = ts.createCompilerHost(parsed.options, true);
  const realReadFile = compilerHost.readFile.bind(compilerHost);
  const realFileExists = compilerHost.fileExists.bind(compilerHost);
  const realGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);

  compilerHost.fileExists = (name: string) => {
    if (virtualFiles.has(path.normalize(name))) return true;
    if (realFileExists(name)) return true;
    return Boolean(gtsForRequest(name));
  };

  compilerHost.readFile = (name: string) => {
    const norm = path.normalize(name);
    const v = virtualFiles.get(norm);
    if (v !== undefined) return v;
    if (realFileExists(name)) return realReadFile(name);
    const gtsPath = gtsForRequest(name);
    if (gtsPath) {
      const rewritten = rewriteGtsToShadow(ctx, gtsPath);
      if (rewritten !== null) {
        virtualFiles.set(norm, rewritten);
        return rewritten;
      }
    }
    return realReadFile(name);
  };

  compilerHost.getSourceFile = (name: string, langVersion, onError) => {
    const norm = path.normalize(name);
    let v = virtualFiles.get(norm);
    if (v === undefined) {
      const gtsPath = gtsForRequest(name);
      if (gtsPath) {
        const rewritten = rewriteGtsToShadow(ctx, gtsPath);
        if (rewritten !== null) {
          v = rewritten;
          virtualFiles.set(norm, v);
        }
      }
    }
    if (typeof v === 'string') {
      return ts.createSourceFile(name, v, langVersion, true, ts.ScriptKind.TS);
    }
    return realGetSourceFile(name, langVersion, onError);
  };

  // Module resolution shim for `import './foo.gts'` literal extensions.
  // TS's standard resolution doesn't recognize `.gts` as a module-bearing
  // extension; we have to intervene and tell it "yes that path resolves,
  // treat it as a `.ts` source." The file's contents are then loaded via
  // the `getSourceFile` shim above (which sees the `.gts` path and serves
  // the rewritten content).
  compilerHost.resolveModuleNameLiterals = (literals, containingFile, _redirectedReference, options) => {
    return literals.map((literal) => {
      const moduleName = literal.text;
      if (moduleName.endsWith('.gts') || moduleName.endsWith('.gjs')) {
        // Containing file may be a `.ts` shadow we created; resolving relative
        // to its directory still lands on the right `.gts`/`.gjs` path because
        // we lay shadows alongside originals.
        const target = path.resolve(path.dirname(containingFile), moduleName);
        if (fs.existsSync(target)) {
          return {
            resolvedModule: {
              resolvedFileName: target,
              extension: ts.Extension.Ts,
              isExternalLibraryImport: false,
            },
          };
        }
      }
      const r = ts.resolveModuleName(moduleName, containingFile, options, compilerHost);
      return { resolvedModule: r.resolvedModule };
    });
  };

  ctx.compilerHost = compilerHost;
  programByTsconfig.set(tsconfigPath, ctx);
  return ctx;
}

// Rewrite a .gts file via Glint's rewriteModule and return the transformed
// TypeScript source. Returns null on parse failure. Result is suitable as a
// virtual .ts file for the TS program.
function rewriteGtsToShadow(ctx: ProgramContext, gtsPath: string): string | null {
  const { deps, ts } = ctx;
  let glintConfig: GlintConfig;
  try {
    glintConfig = deps.createDefaultConfig(ts, ctx.projectRoot);
  } catch {
    return null;
  }
  let contents: string;
  try {
    contents = fs.readFileSync(gtsPath, 'utf8');
  } catch {
    return null;
  }
  let transformed: GlintRewriteResult | null;
  try {
    transformed = deps.rewriteModule(
      ts,
      { script: { filename: gtsPath, contents } },
      glintConfig.environment,
    );
  } catch {
    return null;
  }
  return transformed?.transformedContents ?? null;
}

function ensureProgram(ctx: ProgramContext): TS.Program {
  const { ts, parsed, virtualFiles, compilerHost, extraRootNames } = ctx;
  // Build the rootNames set. Cheap re-walk every call.
  const rootNames = [...new Set([...virtualFiles.keys(), ...parsed.fileNames, ...extraRootNames])];
  // Skip ts.createProgram when rootNames haven't changed since last call —
  // big cold-run speedup paired with `preloadGlintFiles`, which populates
  // virtualFiles up-front so subsequent `extractAttrTypeMap` calls don't
  // each trigger an incremental rebuild. (Even with `oldProgram`, each
  // createProgram costs hundreds of ms per file × N files = real time.)
  const rootKey = `${rootNames.length}|${rootNames.slice().sort().join('|')}`;
  if (ctx.lastRootKey === rootKey && ctx.program) {
    return ctx.program;
  }
  ctx.program = ts.createProgram({
    rootNames,
    options: parsed.options,
    host: compilerHost,
    oldProgram: ctx.program ?? undefined,
  });
  ctx.lastRootKey = rootKey;
  return ctx.program;
}

function locKey(line: number, column: number): string {
  return `${line}:${column}`;
}

interface PreloadProgress {
  done: number;
  total: number;
  phase: 'rewrite' | 'program' | 'done';
}

interface SkipEntry {
  file: string;
  message?: string;
}

export interface PreloadStats {
  loaded: number;
  cached: number;
  skipped: number;
  skips: {
    nonGts: SkipEntry[];
    readError: SkipEntry[];
    rewriteError: SkipEntry[];
    rewriteEmpty: SkipEntry[];
  };
}

/**
 * Pre-load a batch of `.gts` / `.gjs` files into the TS program so the
 * subsequent per-file `extractAttrTypeMap` calls can reuse a single
 * program build instead of triggering N incremental rebuilds.
 *
 * Without preload (cold run on N files): each `extractAttrTypeMap` adds
 * the validated file to `virtualFiles` and calls `ensureProgram`,
 * triggering an incremental TS program rebuild. N rebuilds × hundreds
 * of ms each = the dominant cold-run cost.
 *
 * With preload: rewrite ALL files up-front and stash their virtual
 * shadows in one go; one `ensureProgram` call builds the program once;
 * subsequent per-file calls hit `lastRootKey` cache and reuse the
 * program. Per-file cost drops to just the AST walk + TypeChecker
 * queries.
 *
 * Best-effort: failure to load deps / find tsconfig / rewrite a single
 * file is silently skipped (caller's per-file path will run as
 * normal). Cached entries (per-file disk cache) are skipped — no need
 * to load them into the program if we'll just return cached results.
 */
export function preloadGlintFiles(
  filenames: readonly string[],
  onProgress?: (p: PreloadProgress) => void,
): PreloadStats {
  const empty = (): PreloadStats => ({
    loaded: 0,
    cached: 0,
    skipped: 0,
    skips: { nonGts: [], readError: [], rewriteError: [], rewriteEmpty: [] },
  });
  if (!filenames || filenames.length === 0) {
    return empty();
  }
  const allSkipped = (): PreloadStats => {
    const s = empty();
    s.skipped = filenames.length;
    return s;
  };
  // Find the first .gts/.gjs file to seed deps + tsconfig discovery.
  const seed = filenames.find((f) => f.endsWith('.gts') || f.endsWith('.gjs'));
  if (!seed) return allSkipped();
  const deps = loadDeps(seed);
  if (!deps) return allSkipped();
  const tsconfigPath = findTsconfig(seed);
  if (!tsconfigPath) return allSkipped();
  const ctx = getProgramContext(tsconfigPath, deps);
  if (!ctx) return allSkipped();
  const { ts, rewriteModule, createDefaultConfig } = deps;
  let glintConfig: GlintConfig;
  try {
    glintConfig = createDefaultConfig(ts, ctx.projectRoot);
  } catch {
    return allSkipped();
  }

  let loaded = 0;
  let cached = 0;
  const skips: PreloadStats['skips'] = {
    nonGts: [],
    readError: [],
    rewriteError: [],
    rewriteEmpty: [],
  };
  let done = 0;
  const skippedTotal = (): number =>
    skips.nonGts.length + skips.readError.length + skips.rewriteError.length + skips.rewriteEmpty.length;
  for (const filename of filenames) {
    done++;
    if (!filename.endsWith('.gts') && !filename.endsWith('.gjs')) {
      skips.nonGts.push({ file: filename });
      onProgress?.({ done, total: filenames.length, phase: 'rewrite' });
      continue;
    }
    let contents: string;
    try {
      contents = fs.readFileSync(filename, 'utf8');
    } catch (err) {
      skips.readError.push({
        file: filename,
        message: err instanceof Error ? err.message : String(err),
      });
      onProgress?.({ done, total: filenames.length, phase: 'rewrite' });
      continue;
    }
    // If a cached extraction exists for this file, skip the rewrite —
    // we'll never need its rewritten contents in the program.
    if (readCache(filename, contents, tsconfigPath)) {
      cached++;
      onProgress?.({ done, total: filenames.length, phase: 'rewrite' });
      continue;
    }
    let transformed: GlintRewriteResult | null;
    try {
      transformed = rewriteModule(
        ts,
        { script: { filename, contents } },
        glintConfig.environment,
      );
    } catch (err) {
      skips.rewriteError.push({
        file: filename,
        message: err instanceof Error ? err.message : String(err),
      });
      onProgress?.({ done, total: filenames.length, phase: 'rewrite' });
      continue;
    }
    if (!transformed) {
      // Negative cache: stash an empty result so subsequent runs hit
      // the cache instead of re-parsing this file as "rewrite returned
      // empty" every time. Stable for this (content + tsconfig +
      // plugin version) — typically a `.gts` service file with no
      // `<template>` block. Without this, no-template files
      // perpetually show up under "analyzed" in the summary, which
      // reads as "why aren't these cached?" noise.
      writeCache(filename, contents, tsconfigPath, {
        attrTypeMap: new Map(),
        componentTagMap: new Map(),
        componentAttrMap: new Map(),
      });
      skips.rewriteEmpty.push({ file: filename });
      onProgress?.({ done, total: filenames.length, phase: 'rewrite' });
      continue;
    }
    const tsFilename = filename.replace(/\.(gts|gjs)$/, '.ts');
    ctx.virtualFiles.set(path.normalize(tsFilename), transformed.transformedContents);
    loaded++;
    onProgress?.({ done, total: filenames.length, phase: 'rewrite' });
  }
  if (loaded > 0) {
    onProgress?.({ done: filenames.length, total: filenames.length, phase: 'program' });
    // Single program build with everything seeded. Skipped when loaded
    // is 0 — no virtualFiles changed, no program needed up-front (the
    // per-file `extractAttrTypeMap` path triggers a program build on
    // demand for any file that misses cache).
    ensureProgram(ctx);
  }
  // Always emit `done` so the caller's TTY progress line (if any) gets
  // cleared — even on the all-cached path where no `program` phase
  // fired. Without this, the throttled "template 1/N" rewrite line
  // stays on screen and the summary writes right after it.
  onProgress?.({ done: filenames.length, total: filenames.length, phase: 'done' });
  return { loaded, cached, skipped: skippedTotal(), skips };
}

// TypeScript ships `HTMLElementTagNameMap` in lib.dom.d.ts as
// `{ a: HTMLAnchorElement; button: HTMLButtonElement; ... }`. We invert it
// at runtime using the project's TS program — no hardcoded list to keep in
// sync with TS lib version. SVG and MathML maps follow the same shape.
function buildElementTypeToTag(ts: typeof TS, program: TS.Program): Map<string, string> {
  const map = new Map<string, string>();
  const tagNameMaps = ['HTMLElementTagNameMap', 'SVGElementTagNameMap', 'MathMLElementTagNameMap'];
  for (const sourceFile of program.getSourceFiles()) {
    if (!/lib\.dom(?:\.iterable)?\.d\.ts$/.test(sourceFile.fileName)) {
      continue;
    }
    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isInterfaceDeclaration(node) && tagNameMaps.includes(node.name.text)) {
        for (const member of node.members) {
          if (!ts.isPropertySignature(member) || !member.type) continue;
          const tag = ts.isStringLiteral(member.name)
            ? member.name.text
            : ts.isIdentifier(member.name)
            ? member.name.text
            : null;
          const typeName =
            ts.isTypeReferenceNode(member.type) && ts.isIdentifier(member.type.typeName)
              ? member.type.typeName.text
              : null;
          if (tag && typeName && !map.has(typeName)) {
            map.set(typeName, tag);
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  return map;
}

// Resolve a component invocation's rendered element type. Reads
// `emitComponent(...).element` — Glint's DSL surfaces the Signature's
// Element type there for both class-component and template-only-component
// (TOC) invocations. Returns:
//   - tag name (e.g. 'button')   if Element is a known DOM type
//   - 'transparent'              if Element is `unknown` (yields-only / no
//                                Element declared) — children float into
//                                parent, no wrapper element forced
//   - null                       if we can't introspect or Element is some
//                                other type — caller falls back to
//                                transparent neutralization
function resolveComponentElement(
  ts: typeof TS,
  checker: TS.TypeChecker,
  emitComponentCall: TS.CallExpression,
  elementTypeToTag: Map<string, string>,
): string | null {
  const callType = checker.getTypeAtLocation(emitComponentCall);
  const elementProp = callType.getProperty('element');
  if (!elementProp) {
    return null;
  }
  const elementType = checker.getTypeOfSymbolAtLocation(elementProp, emitComponentCall);
  // Treat `unknown` (no Element declared in Signature) and `any` (TS couldn't
  // infer — common in big files with cascading type errors, or with
  // `satisfies TOC<…>` patterns) the same way: transparent. Children float
  // into parent's content model. Less wrong than forcing an `<x-c>` wrapper
  // that fights content-model rules in places like <tfoot>, <select>,
  // <menu>, etc.
  if (elementType.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) {
    return 'transparent';
  }
  // Pick a single tag for unions: take the first branch's mapping.
  const branches = elementType.isUnion() ? elementType.types : [elementType];
  for (const branch of branches) {
    const name = branch.getSymbol()?.name;
    if (name && elementTypeToTag.has(name)) {
      return elementTypeToTag.get(name) ?? null;
    }
  }
  return null;
}

function describeType(checker: TS.TypeChecker, type: TS.Type): AttrTypeInfo {
  if (type.isStringLiteral()) {
    return { kind: 'string-literal', values: [type.value] };
  }
  if (type.isUnion()) {
    if (type.types.every((t): t is TS.StringLiteralType => t.isStringLiteral())) {
      return { kind: 'string-literal-union', values: type.types.map((t) => t.value) };
    }
  }
  return { kind: 'other', text: checker.typeToString(type) };
}

// For a given mustache `transformedRange` from Glint's mapping, find the TS
// AST node and resolve its type. Glint's transformedRange covers the whole
// `__glintDSL__.resolveOrReturn(__glintRef__.args.X)()` expression; we want
// the inner argument (the actual user-typed expression).
function findInnerTypeAtTransformedRange(
  ts: typeof TS,
  sourceFile: TS.SourceFile,
  checker: TS.TypeChecker,
  range: { start: number; end: number },
): TS.Type | null {
  // The expression covering transformedRange is typically a CallExpression
  // shaped like `__glintDSL__.resolveOrReturn(<inner>)()`. We want the
  // <inner> argument's type. Strategy: find the deepest node whose start
  // falls within `range`, walk back up to its enclosing CallExpression of
  // resolveOrReturn / resolve, and read its first argument.
  let candidate: TS.Node | undefined;
  function visit(node: TS.Node): void {
    const start = node.getStart();
    const end = node.getEnd();
    if (end <= range.start || start >= range.end) {
      return;
    }
    if (start >= range.start && end <= range.end && ts.isCallExpression(node)) {
      candidate = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!candidate) {
    return null;
  }
  // Walk up to find a CallExpression whose callee is `resolveOrReturn` or
  // `resolve` — the @glint/ember-tsc DSL functions that wrap the inner
  // user expression.
  let cur: TS.Node | undefined = candidate;
  while (cur) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      const name = cur.expression.name.escapedText;
      if (name === 'resolveOrReturn' || name === 'resolve') {
        const inner = cur.arguments[0];
        if (inner) {
          return checker.getTypeAtLocation(inner);
        }
      }
    }
    cur = cur.parent;
  }
  // Fallback: just type the candidate itself.
  return checker.getTypeAtLocation(candidate);
}

/**
 * Extract a map of attribute-value MustacheStatement positions to TS type
 * info for the given .gts file. Returns null if Glint isn't installed or
 * the project doesn't have a tsconfig.
 *
 * Map keys are `"line:column"` tuples (template-relative — Glimmer's
 * AST loc convention) so blank.ts can look up by Glimmer node loc.
 */
export function extractAttrTypeMap(filename: string, contents: string): ExtractionResult | null {
  const deps = loadDeps(filename);
  if (!deps) {
    return null;
  }
  const tsconfigPath = findTsconfig(filename);
  if (!tsconfigPath) {
    return null;
  }

  // Disk-cache fast path. The extraction result is a pure function of
  // (file content + tsconfig content + plugin version) — repeat runs
  // (CI, pre-commit, IDE re-validation on unchanged files) skip the
  // entire Glint pipeline. See `lib/cache.ts`.
  const cached = readCache(filename, contents, tsconfigPath);
  if (cached) {
    return cached;
  }

  const ctx = getProgramContext(tsconfigPath, deps);
  if (!ctx) {
    return null;
  }
  const { ts, rewriteModule, createDefaultConfig } = deps;

  let glintConfig: GlintConfig;
  try {
    glintConfig = createDefaultConfig(ts, ctx.projectRoot);
  } catch {
    return null;
  }
  let transformed: GlintRewriteResult | null;
  try {
    transformed = rewriteModule(
      ts,
      { script: { filename, contents } },
      glintConfig.environment,
    );
  } catch {
    return null;
  }
  if (!transformed) {
    // Negative cache: same rationale as in `preloadGlintFiles` — a file
    // with no `<template>` block has a stable "no Glint output" result
    // for this (content + tsconfig + plugin version). Cache it so
    // subsequent calls hit cache instead of retrying the rewrite.
    const empty: ExtractionResult = {
      attrTypeMap: new Map(),
      componentTagMap: new Map(),
      componentAttrMap: new Map(),
    };
    writeCache(filename, contents, tsconfigPath, empty);
    return empty;
  }

  // Stash the rewritten content for the file being validated. Cross-file
  // .gts imports get handled lazily by the compilerHost shims.
  const tsFilename = filename.replace(/\.(gts|gjs)$/, '.ts');
  ctx.virtualFiles.set(path.normalize(tsFilename), transformed.transformedContents);
  const program = ensureProgram(ctx);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(tsFilename);
  if (!sourceFile) {
    return null;
  }

  const attrTypeMap = new Map<string, AttrTypeInfo>();
  const componentTagMap = new Map<string, string>();
  // Maps "line:column" of a component invocation to its resolved
  // splatted-root attributes (literal values from the component's
  // template, e.g. `{ type: 'range', min: '0', max: '100' }` for an
  // <input>-rooted slider). Built alongside componentTagMap when we
  // can resolve the component's declaration source file.
  const componentAttrMap = new Map<string, ComponentAttrs>();
  if (!ctx.elementTypeToTag) {
    ctx.elementTypeToTag = buildElementTypeToTag(ts, program);
  }
  const elementTypeToTag = ctx.elementTypeToTag;

  function walkMapping(node: GlimmerAstMappingNode | undefined, spanTransformedStart: number): void {
    if (!node) return;
    const sourceNode = node.sourceNode;

    // Attribute-value mustache → TS type lookup.
    if (
      sourceNode?.type === 'MustacheStatement' &&
      node.parent?.sourceNode?.type === 'AttrNode' &&
      node.transformedRange &&
      sourceNode.loc?.start
    ) {
      const absRange = {
        start: node.transformedRange.start + spanTransformedStart,
        end: node.transformedRange.end + spanTransformedStart,
      };
      const type = findInnerTypeAtTransformedRange(ts, sourceFile!, checker, absRange);
      if (type) {
        const key = locKey(sourceNode.loc.start.line, sourceNode.loc.start.column);
        const desc = describeType(checker, type);
        attrTypeMap.set(key, desc);
      }
    }

    // PascalCase component invocation → resolve via Glint's emitComponent
    // call. Look at the component's PathExpression child (the tag-name
    // reference); the enclosing emitComponent call is what Glint emitted
    // for this invocation. Read its return-type's `.element` property.
    if (
      sourceNode?.type === 'PathExpression' &&
      node.parent?.sourceNode?.type === 'ElementNode' &&
      node.parent.sourceNode.tag &&
      /^[A-Z]/.test(node.parent.sourceNode.tag) &&
      node.transformedRange &&
      node.parent.sourceNode.loc?.start
    ) {
      const absRange = {
        start: node.transformedRange.start + spanTransformedStart,
        end: node.transformedRange.end + spanTransformedStart,
      };
      const emitCall = findEnclosingEmitComponent(ts, sourceFile!, absRange);
      const tag = emitCall ? resolveComponentElement(ts, checker, emitCall, elementTypeToTag) : null;
      const elementLoc = node.parent.sourceNode.loc.start;
      const key = locKey(elementLoc.line, elementLoc.column);
      if (tag) {
        componentTagMap.set(key, tag);
      }
      // Resolve the component's declaration source file (cross-file or
      // same-file). When found, parse its `<template>` for the splatted
      // root and stash literal attributes for blank.ts to inject.
      if (emitCall) {
        const declFile = findComponentDeclSourceFile(ts, checker, emitCall);
        if (declFile) {
          const gtsPath = resolveGtsPath(declFile);
          if (gtsPath) {
            const roots = getSplattedRootsForFile(gtsPath);
            // MVP heuristic: pick the first template's splatted root.
            // Most component files have a single `<template>`. Multi-
            // template files (helpers + default export) would need
            // declaration-to-template matching, deferred.
            const first = roots[0];
            if (first) {
              componentAttrMap.set(key, first);
            }
          }
        }
        // Classic Ember addon fallback: when the JS-driven resolution
        // didn't yield a concrete tag (null, or 'transparent' meaning
        // unknown/any element type), try the component's `.hbs` template
        // via the addon's import path. Modern shapes (class form, TOC
        // forms, curried block-params) already resolved above take
        // priority — this only runs as a last resort.
        if (tag === null || tag === 'transparent') {
          const addonRoot = resolveAddonHbsTemplate(ts, checker, emitCall, filename);
          if (addonRoot) {
            componentTagMap.set(key, addonRoot.tag);
            componentAttrMap.set(key, addonRoot);
          }
        }
      }
    }

    for (const child of node.children ?? []) {
      walkMapping(child, spanTransformedStart);
    }
  }

  for (const span of transformed.correlatedSpans) {
    if (span.glimmerAstMapping) {
      walkMapping(span.glimmerAstMapping, span.transformedStart);
    }
  }

  const result: ExtractionResult = { attrTypeMap, componentTagMap, componentAttrMap };
  writeCache(filename, contents, tsconfigPath, result);
  return result;
}

// Resolve the source file containing a component's declaration. Glint's
// rewrite emits component invocations as
//   __glintDSL__.emitComponent(__glintDSL__.resolve(Comp)({...}))
// so we navigate the AST: emitCall.arguments[0] is the resolve()(...)
// call, whose expression is resolve(Comp), whose first argument is the
// component reference. Aliased imports (the common case) are de-aliased
// via `checker.getAliasedSymbol` to land on the original declaration.
function findComponentDeclSourceFile(
  ts: typeof TS,
  checker: TS.TypeChecker,
  emitCall: TS.CallExpression,
): string | null {
  const innerCall = emitCall.arguments[0];
  if (!innerCall || !ts.isCallExpression(innerCall)) return null;
  const resolveCall = innerCall.expression;
  if (!ts.isCallExpression(resolveCall)) return null;
  const componentRef = resolveCall.arguments[0];
  if (!componentRef) return null;
  let symbol = checker.getSymbolAtLocation(componentRef);
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const decl = symbol.declarations?.[0];
  if (!decl) return null;
  return decl.getSourceFile().fileName;
}

// Resolve the rendered tag (and splatted-root attrs) for a classic Ember
// addon component imported as `import X from '<addon>/components/<name>'`
// — addons whose template lives at `addon/templates/components/<name>.hbs`
// (legacy v1 addon) or `app/components/<name>.hbs` (Module Unification /
// authored-as-app shim). These have no JS-side `Signature['Element']`, no
// `satisfies TOC<…>`, so the JS-driven resolution paths return null.
//
// We extract the import's `moduleSpecifier` from the AST, match the
// addon-component shape, walk up from the consumer file to find
// `node_modules/<addon>`, and probe the canonical template paths. The
// `.hbs` file is parsed with the same `extractSplattedRootFromTemplate`
// helper used for `.gts` splatted-root extraction.
//
// Returns null when the import doesn't match an addon-component shape,
// when the addon isn't found in node_modules, when no template file
// exists at the expected paths, or when the template parses to no
// element root (e.g. `{{outlet}}`-only).
// Cache: (consumerFile-dir + importPath) → resolved ComponentAttrs.
// POSITIVE results only — the map type enforces that. Caching negatives
// indefinitely would permanently hide a template that's later installed
// (linked workspace addons, IDE/watch mode where the user installs an
// addon mid-session). Templates with many invocations of the same addon
// component would otherwise hit the dir walk + multiple existsSync
// probes + read+parse on every call; what we actually wanted to skip
// with caching is the file read + Glimmer parse on positive hits.
// Negatives stay cheap (regex + a handful of existsSync calls up to
// the filesystem root) and re-probe each call.
//
// Keyed on the consumer file's directory so a monorepo with multiple
// node_modules trees stays correct (different projects can resolve the
// same addonName to different physical paths).
//
// Note: this in-memory cache is independent of the disk cache in
// `lib/cache.ts`, which keys by consumer file content + mtime; that
// disk cache will preserve a prior negative resolution until the
// consumer file changes. Hot-installing a new addon mid-session may
// require an editor restart to pick up if the consumer file's mtime
// hasn't moved.
const addonHbsResolutionCache = new Map<string, ComponentAttrs>();

function resolveAddonHbsTemplate(
  ts: typeof TS,
  checker: TS.TypeChecker,
  emitComponentCall: TS.CallExpression,
  consumerFile: string,
): ComponentAttrs | null {
  const innerCall = emitComponentCall.arguments[0];
  if (!innerCall || !ts.isCallExpression(innerCall)) return null;
  const resolveCall = innerCall.expression;
  if (!ts.isCallExpression(resolveCall)) return null;
  const componentRef = resolveCall.arguments[0];
  if (!componentRef) return null;
  const symbol = checker.getSymbolAtLocation(componentRef);
  if (!symbol) return null;
  let importDecl: TS.Node | undefined;
  for (const decl of symbol.declarations ?? []) {
    let n: TS.Node | undefined = decl;
    while (n && !ts.isImportDeclaration(n)) n = n.parent;
    if (n && ts.isImportDeclaration(n)) {
      importDecl = n;
      break;
    }
  }
  if (!importDecl || !ts.isImportDeclaration(importDecl)) return null;
  const moduleSpecifier = importDecl.moduleSpecifier;
  if (!ts.isStringLiteral(moduleSpecifier)) return null;
  const importPath = moduleSpecifier.text;
  const consumerDir = path.dirname(consumerFile);
  const cacheKey = `${consumerDir}\0${importPath}`;
  const cached = addonHbsResolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;
  // Accept `<addon>/components/<name>` and `<addon>/templates/components/<name>`.
  // Addon name follows npm package-name rules: lowercase letters, digits,
  // `.`, `-`, `_`; cannot start with `.` / `_`; scoped names allowed
  // (`@org/pkg`). We explicitly disallow `..` to prevent path traversal.
  // Component name is kebab-case, lowercase only, allowing nested-by-slash
  // like `forms/text-input`.
  const PKG = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?';
  const COMPONENT = '[a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)*';
  const importRe = new RegExp(
    `^(@${PKG}\\/${PKG}|${PKG})\\/(?:templates\\/)?components\\/(${COMPONENT})$`,
  );
  const m = importRe.exec(importPath);
  if (!m || importPath.includes('..')) return null;
  const addonName = m[1]!;
  const componentName = m[2]!;
  // Walk up looking for node_modules/<addon>. Always check the current
  // dir BEFORE stepping up, so the filesystem root (e.g. POSIX `/`,
  // Windows `C:\`) is also probed — Node's module resolver does this
  // and we should match. A `while (dir !== path.dirname(dir))` loop
  // would skip the root.
  let dir = consumerDir;
  for (;;) {
    const addonRoot = path.join(dir, 'node_modules', addonName);
    if (fs.existsSync(addonRoot)) {
      for (const subPath of [
        `addon/templates/components/${componentName}.hbs`,
        `app/components/${componentName}.hbs`,
        `addon/components/${componentName}.hbs`,
      ]) {
        const hbsPath = path.join(addonRoot, subPath);
        if (fs.existsSync(hbsPath)) {
          // Read can still fail post-existsSync (TOCTOU race, perms,
          // unreadable file). Return null without caching — the read
          // may succeed on a subsequent call once the underlying issue
          // clears.
          let contents: string;
          try {
            contents = fs.readFileSync(hbsPath, 'utf8');
          } catch {
            return null;
          }
          const result = extractSplattedRootFromTemplate(contents);
          // Guard: only return when the addon's root element is a
          // native HTML tag. If the addon template's root is itself a
          // component (PascalCase tag) we'd otherwise feed that
          // non-native name into `componentTagMap`, and blank.ts's
          // substitution path would rename the consumer's invocation
          // to that PascalCase string — making content-model checks
          // worse than the transparent-blanking fallback. In that
          // case treat as unresolved so the caller falls back to
          // `'transparent'` (children float to the actual parent).
          if (!result || !isNativeTag(result.tag)) return null;
          addonHbsResolutionCache.set(cacheKey, result);
          return result;
        }
      }
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Test-only: clear the addon-hbs resolution cache. Tests that mutate
// fixtures' .hbs templates between runs need this to avoid stale hits.
export function _clearAddonHbsCache(): void {
  addonHbsResolutionCache.clear();
}

// Convert a TS sourceFile path to its underlying `.gts` or `.gjs` path.
// The compilerHost shim lays virtual `.ts` shadows alongside their
// originals; both forms may show up in `decl.getSourceFile().fileName`
// depending on how TS resolved the import. Returns null when no
// underlying source file exists.
function resolveGtsPath(declFile: string): string | null {
  if (declFile.endsWith('.gts') || declFile.endsWith('.gjs')) {
    return fs.existsSync(declFile) ? declFile : null;
  }
  if (declFile.endsWith('.ts') && !declFile.endsWith('.d.ts')) {
    const base = declFile.slice(0, -3);
    for (const ext of ['.gts', '.gjs']) {
      const candidate = base + ext;
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Find the `__glintDSL__.emitComponent(...)` CallExpression that contains
// the given range (which corresponds to a component's PathExpression in
// the original template). Glint emits component invocations as
// `emitComponent(__glintDSL__.resolve(Comp)({...}))`, and the surrounding
// emitComponent's return type carries the rendered Element type.
function findEnclosingEmitComponent(
  ts: typeof TS,
  sourceFile: TS.SourceFile,
  range: { start: number; end: number },
): TS.CallExpression | null {
  let result: TS.CallExpression | undefined;
  function visit(node: TS.Node): void {
    const start = node.getStart();
    const end = node.getEnd();
    if (end <= range.start || start >= range.end) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.escapedText === 'emitComponent' &&
      start <= range.start &&
      end >= range.end
    ) {
      // Overwrite with each deeper match so we end up with the innermost
      // emitComponent call that contains the range.
      result = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result ?? null;
}
