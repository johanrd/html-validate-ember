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

import { Preprocessor } from 'content-tag';
import { preprocess as glimmerPreprocess, traverse, type AST } from '@glimmer/syntax';

import { isNativeTag, stripBlockParamTypeAnnotations } from '../blank.js';
import type { ComponentAttrs } from './builtin-components.js';
import { readCache, writeCache } from './cache.js';
import type { AttrTypeInfo, ExtractionResult } from './cache.js';
import { findTemplateSource } from './resolver/template-source.js';
import { resolveTemplate, resolveYieldHashBinding, type Resolution } from './resolver/walk.js';

const consumerPreprocessor = new Preprocessor();

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
//
// Tags whose mapped type is the bare base class (`HTMLElement`,
// `SVGElement`, `MathMLElement`) are *intentionally excluded* from the
// inversion. Many tags share the bare base — `abbr`, `address`, `b`, `cite`,
// `code`, …  all map to `HTMLElement` — so the inversion would arbitrarily
// pick whichever appears first (currently `abbr`) and FP-attribute
// downstream content. A component declaring `Signature['Element'] =
// HTMLElement` (the generic) typically means "I render *some* generic
// container; element-specific rules should not apply." Falling through to
// 'transparent' (children float to actual parent) is the right behaviour.
const GENERIC_BASE_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  'HTMLElement',
  'SVGElement',
  'MathMLElement',
]);

// Tags whose role on the consumer's parent context is structurally
// meaningful — they require specific parents (`<li>` requires
// `<ul>`/`<ol>`/`<menu>`, etc.). When a component's outer wrapper is
// one of these, KEEP the outer for substitution: dropping it would
// break the consumer's parent-context validation. For permissive
// outer wrappers (`<div>`, `<span>`, etc.), prefer the yield-ancestor
// when it differs — that's where consumer-yielded content actually
// lands at runtime, and content-model rules hinge on it.
const STRUCTURAL_CHILD_TAGS: ReadonlySet<string> = new Set([
  'option', 'optgroup', 'th', 'td', 'tr', 'thead', 'tbody', 'tfoot',
  'caption', 'colgroup', 'col', 'li', 'legend', 'summary',
]);

// Translate a Resolution from the canonical resolver into the
// componentTagMap + componentAttrMap shape that blank.ts consumes.
//
// `transparent` from the canonical resolver overrides any prior
// TS-side resolveComponentElement pick. The TS-side resolves to the
// FIRST matching branch of a Signature['Element'] union — which for
// `HTMLAnchorElement | HTMLButtonElement` arbitrarily picks one. The
// canonical resolver, however, walks the actual template AST: when
// the outer is a conditional with differing branches (HDS's
// `HdsInteractive` shape: `{{#if @route}}<LinkTo>{{else if @href}}
// <a>{{else}}<button>{{/if}}`), it returns transparent — meaning
// "no single tag pins this; children float to the actual parent."
// Overriding the arbitrary union pick with transparent eliminates
// FPs cascading from the wrong branch (`<div>` under `<button>` for
// elements that would actually render `<a>` at runtime).
function applyResolution(
  componentTagMap: Map<string, string>,
  componentAttrMap: Map<string, ComponentAttrs>,
  key: string,
  resolution: Resolution,
): void {
  if (resolution.kind === 'transparent') {
    componentTagMap.set(key, 'transparent');
    componentAttrMap.delete(key);
    return;
  }
  if (!isNativeTag(resolution.tag)) return;

  let chosenTag = resolution.tag;
  let chosenAttrs: Map<string, string> = resolution.attrs;
  let hasSplat = resolution.hasSplat;
  const yieldTag = resolution.yieldAncestorTag;
  if (
    yieldTag &&
    yieldTag !== resolution.tag &&
    !STRUCTURAL_CHILD_TAGS.has(resolution.tag) &&
    // Guard against substituting the invocation with a tag that
    // itself only makes sense under a specific parent (e.g.
    // `<table><thead>{{yield}}</thead></table>` — preferring
    // `<thead>` would put it under whatever the call-site parent
    // happens to be, often `<div>`, reintroducing the very
    // element-permitted-parent FPs this preference is meant to
    // suppress). Keep the outer wrapper when the yield-ancestor
    // itself is structural-only.
    !STRUCTURAL_CHILD_TAGS.has(yieldTag) &&
    isNativeTag(yieldTag)
  ) {
    chosenTag = yieldTag;
    chosenAttrs = resolution.yieldAncestorAttrs ?? new Map();
    hasSplat = true;
  }

  componentTagMap.set(key, chosenTag);
  componentAttrMap.set(key, {
    tag: chosenTag,
    attrs: Object.fromEntries(chosenAttrs),
    hasSplat,
  });
}

// Parse the consumer file's <template> blocks and build:
//   1. argsByLoc: line:col → @arg literal values for each PascalCase
//      invocation. Lets the resolver propagate `@tag="li"` etc.
//   2. dottedBindings: line:col → resolution context for each dotted
//      invocation `<X.Y>`. Records the enclosing block's binder tag
//      and the hash key, so the resolver can follow the parent's
//      `{{yield (hash Y=...)}}` chain.

interface DottedBinding {
  /** Enclosing block's binder tag (e.g. 'HdsStepperList' for `<HdsStepperList as |S|>`). */
  binderTag: string;
  /** The hash key from the dotted invocation: `<S.Step>` → 'Step'. */
  hashKey: string;
  /** Args the consumer passed to the binder. Lets `(hash Y=@arg)` chain through. */
  binderArgs: Map<string, string>;
  /** line:col of the binder invocation (lookup key into a binder→decl map
   *  populated during the Glint walk). Lets us reach binder templates
   *  that live in the same consumer file (no import to follow). */
  binderKey: string;
}

interface ConsumerInfo {
  argsByLoc: Map<string, Map<string, string>>;
  dottedBindings: Map<string, DottedBinding>;
}

function buildConsumerInfo(filename: string, contents: string): ConsumerInfo {
  const argsByLoc = new Map<string, Map<string, string>>();
  const dottedBindings = new Map<string, DottedBinding>();
  let blocks: Array<{ contents: string; tagName: string }>;
  try {
    blocks = consumerPreprocessor.parse(contents, { filename });
  } catch {
    return { argsByLoc, dottedBindings };
  }
  const templates = blocks.filter((b) => b.tagName === 'template');

  // A block-param scope binds names introduced via `<Binder as |x y|>`.
  // Inner scopes shadow outer; we walk a stack while traversing so a
  // nested `<A as |x|><B as |x|>` resolves `x` to the inner B-binding.
  interface Scope {
    paramName: string;
    binderTag: string;
    binderArgs: Map<string, string>;
    binderKey: string;
  }

  for (const block of templates) {
    let ast: AST.Template;
    try {
      // Match `blankTemplateContent`'s preprocessing: strip TS-flavored
      // block-param type annotations (`as |x: T|`) before parsing so
      // typed-block consumers don't get silently dropped (which would
      // leave argsByLoc/dottedBindings empty for their invocations).
      ast = glimmerPreprocess(stripBlockParamTypeAnnotations(block.contents), {
        mode: 'codemod',
      });
    } catch {
      continue;
    }
    const scopeStack: Scope[] = [];
    function walk(node: AST.Node): void {
      if (node.type === 'ElementNode') {
        const elem = node;
        // Args + dotted-binding lookup happen on entry, before pushing
        // any scope this element introduces. Block-params shadow inside
        // its body, not at the binder itself.
        if (/^[A-Z]/.test(elem.tag) && elem.loc.start) {
          const args = collectLiteralArgs(elem);
          const key = `${elem.loc.start.line}:${elem.loc.start.column}`;
          if (args.size > 0) argsByLoc.set(key, args);
          if (elem.tag.includes('.')) {
            const [paramName, ...tail] = elem.tag.split('.');
            const binding = lookupParam(scopeStack, paramName!);
            if (binding && tail.length === 1) {
              dottedBindings.set(key, {
                binderTag: binding.binderTag,
                hashKey: tail[0]!,
                binderArgs: binding.binderArgs,
                binderKey: binding.binderKey,
              });
            }
          }
        }
        // Push any block-params this element introduces.
        const pushedCount = elem.blockParams.length;
        const elemArgs = collectLiteralArgs(elem);
        const binderKey = elem.loc.start
          ? `${elem.loc.start.line}:${elem.loc.start.column}`
          : '';
        for (const paramName of elem.blockParams) {
          scopeStack.push({
            paramName,
            binderTag: elem.tag,
            binderArgs: elemArgs,
            binderKey,
          });
        }
        for (const child of elem.children) walk(child);
        for (let i = 0; i < pushedCount; i++) scopeStack.pop();
        return;
      }
      if (node.type === 'BlockStatement') {
        for (const child of node.program.body) walk(child);
        if (node.inverse) for (const child of node.inverse.body) walk(child);
        return;
      }
      if (node.type === 'Template') {
        for (const child of node.body) walk(child);
      }
    }
    walk(ast);
  }
  return { argsByLoc, dottedBindings };
}

function collectLiteralArgs(node: AST.ElementNode): Map<string, string> {
  const args = new Map<string, string>();
  for (const attr of node.attributes) {
    if (!attr.name.startsWith('@')) continue;
    const argName = attr.name.slice(1);
    if (attr.value.type === 'TextNode') {
      args.set(argName, attr.value.chars);
    }
  }
  return args;
}

function lookupParam(
  stack: ReadonlyArray<{
    paramName: string;
    binderTag: string;
    binderArgs: Map<string, string>;
    binderKey: string;
  }>,
  name: string,
): { binderTag: string; binderArgs: Map<string, string>; binderKey: string } | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.paramName === name) {
      return {
        binderTag: stack[i]!.binderTag,
        binderArgs: stack[i]!.binderArgs,
        binderKey: stack[i]!.binderKey,
      };
    }
  }
  return null;
}

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
          if (tag && typeName && !GENERIC_BASE_ELEMENT_TYPES.has(typeName) && !map.has(typeName)) {
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
  // `unknown` and `any` are both ambiguous in this position. Glint can surface
  // `.element` this way for yielded-curried refs (`<C.Options>`), TOC
  // declarations (`: TOC<…> =` / `satisfies TOC<…>`), and also in files with
  // cascading TS errors.
  if (elementType.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) {
    const fromTOC = resolveElementFromTOCDeclaration(
      ts,
      checker,
      emitComponentCall,
      elementTypeToTag,
    );
    if (fromTOC !== null) return fromTOC;
    const fromRefType = resolveElementFromComponentRefType(
      ts,
      checker,
      emitComponentCall,
      elementTypeToTag,
    );
    if (fromRefType !== null) return fromRefType;
    return 'transparent';
  }
  // Pick a single tag for unions: take the first matching branch
  // (branches with no DOM mapping are skipped, see matchElementTypeToTag).
  return matchElementTypeToTag(elementType, elementTypeToTag);
}

function matchElementTypeToTag(
  elementType: TS.Type,
  elementTypeToTag: Map<string, string>,
): string | null {
  // Generic base classes (`HTMLElement`, `SVGElement`, `MathMLElement`) are
  // resolved as transparent rather than falling through to `null`. A null
  // return signals "no Glint resolution at all" and lets blank.ts apply
  // built-in name-based fallbacks (e.g. `<Input>` → `<input>`); for a
  // user component declaring `Signature['Element'] = HTMLElement` Glint
  // DID succeed and we just don't know which specific tag — transparent
  // (children float to parent) is the right semantic.
  const branches = elementType.isUnion() ? elementType.types : [elementType];
  let allGenericBase = true;
  for (const branch of branches) {
    const name = branch.getSymbol()?.name;
    if (!name || !GENERIC_BASE_ELEMENT_TYPES.has(name)) {
      allGenericBase = false;
      break;
    }
  }
  if (allGenericBase) return 'transparent';
  // "Essentially all elements" — when the union covers (almost) every
  // HTMLElement type, the author has expressed "this component can
  // render any element"; picking the first matching branch arbitrarily
  // would substitute to whatever happened to be first (often `<a>` or
  // `<h1>`) and cascade FPs into the consumer's content-model checks.
  // Resolve to 'transparent' so children float to the actual parent.
  // Surfaced by HDS's `<HdsLayoutGrid>` declaring
  // `Element: HTMLElementTagNameMap[keyof HTMLElementTagNameMap]`.
  if (branches.length >= ESSENTIALLY_ALL_ELEMENTS_THRESHOLD) {
    return 'transparent';
  }
  // Pick a single tag for unions: take the first matching branch.
  for (const branch of branches) {
    const name = branch.getSymbol()?.name;
    if (name && elementTypeToTag.has(name)) {
      return elementTypeToTag.get(name) ?? null;
    }
  }
  return null;
}

// Threshold below which a union of HTML element types is treated as
// "the author chose specific tags" (we resolve to one of them) and
// above which it's treated as "the author chose effectively all tags"
// (we resolve to 'transparent'). HTMLElementTagNameMap has ~110
// entries; user-declared unions of "any of a handful" are typically
// 5-10 elements. Pick a threshold well above realistic per-component
// declarations but well below 110.
const ESSENTIALLY_ALL_ELEMENTS_THRESHOLD = 30;

// Recover the rendered tag from the *type* of the component-reference
// expression itself — for cases where Glint's `emitComponent(...).element`
// surfaces as `unknown`/`any` (for example yielded-curried block params like
// `<C.Options>`). In these cases the component-ref expression type can still
// carry Signature `Element` via a generic like `TOC<Sig>`.
//
// For both: `aliasTypeArguments[0]` is `Sig` — an object type with
// `Element: T` as a property — so we read `T` and map to a tag.
//
// Returns:
//   - tag name      if Element resolves to a known DOM type
//   - 'transparent' if Element is `unknown` (yields-only)
//   - null          if no aliasTypeArguments / no `Element` property —
//                   caller falls through to plain transparent.
function resolveElementFromComponentRefType(
  ts: typeof TS,
  checker: TS.TypeChecker,
  emitComponentCall: TS.CallExpression,
  elementTypeToTag: Map<string, string>,
): string | null {
  // emitCall is `emitComponent(resolve(Comp)({...}))`; navigate to the
  // component reference expression. Same path findComponentDeclSourceFile
  // uses to walk back to the component identifier.
  const innerCall = emitComponentCall.arguments[0];
  if (!innerCall || !ts.isCallExpression(innerCall)) return null;
  const resolveCall = innerCall.expression;
  if (!ts.isCallExpression(resolveCall)) return null;
  const componentRef = resolveCall.arguments[0];
  if (!componentRef) return null;
  const refType = checker.getTypeAtLocation(componentRef);
  // Try both shapes:
  //   - Type alias `type TOC<S> = …` — type-args land on
  //     `aliasTypeArguments`.
  //   - Generic interface `interface TOC<S>` — type-args land on the
  //     TypeReference's typeArguments, accessible via the public
  //     `checker.getTypeArguments`.
  // We don't know which form the host project's `TOC` (or other
  // signature-carrying generic) uses; check both.
  const aliasArgs = (refType as TS.Type & { aliasTypeArguments?: ReadonlyArray<TS.Type> })
    .aliasTypeArguments;
  let sigType: TS.Type | undefined = aliasArgs?.[0];
  if (!sigType && (refType as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
    const refArgs = checker.getTypeArguments(refType as TS.TypeReference);
    sigType = refArgs[0];
  }
  if (!sigType) return null;
  const eltSym = sigType.getProperty('Element');
  if (!eltSym) return null;
  const eltType = checker.getTypeOfSymbolAtLocation(eltSym, componentRef);
  if (eltType.flags & ts.TypeFlags.Unknown) return 'transparent';
  const tag = matchElementTypeToTag(eltType, elementTypeToTag);
  if (tag !== null) return tag;
  return null;
}

// Recover the rendered tag for a TOC declared with a TOC type annotation,
// in either of the two equivalent forms:
//   `const X = <template>...</template> satisfies TOC<{ Element: T }>;`
//   `const X: TOC<{ Element: T }> = <template>...</template>;`
//
// Glint's TOC overload reaches the same `.element` property surface as the
// class form, but for both the `satisfies` and `: TOC<…> =` forms `.element`
// surfaces as `unknown` (or `any` in cascading-error files) even though
// `T` is statically known. Walk the component reference back to its
// declaration, find the TOC<…> annotation, and pull `Element` off the
// type-arg directly.
//
// We gate on the type name being literally `TOC` to avoid mis-resolving
// unrelated generic annotations that happen to have a property called
// `Element` — a rare shape, but harmless to guard against.
//
// Returns:
//   - tag name      if Element resolves to a known DOM type
//   - 'transparent' if Element is `unknown` (yields-only TOC)
//   - null          if no TOC annotation found, no `Element` property,
//                   or some unexpected shape — caller falls through
function resolveElementFromTOCDeclaration(
  ts: typeof TS,
  checker: TS.TypeChecker,
  emitComponentCall: TS.CallExpression,
  elementTypeToTag: Map<string, string>,
): string | null {
  const symbol = getComponentSymbolFromEmitCall(ts, checker, emitComponentCall);
  if (!symbol) return null;
  const declarations = symbol.declarations ?? [];
  for (const decl of declarations) {
    if (!ts.isVariableDeclaration(decl)) continue;
    // Form A: `const X: TOC<S> = ...;` — type annotation is `TOC<S>`.
    // Form B: `const X = <template>...</template> satisfies TOC<S>;` — the
    // initializer is a SatisfiesExpression whose `.type` is `TOC<S>`.
    // For both: locate the `TOC<…>` TypeReference, pull its first type
    // argument (S), then read S['Element'].
    let tocTypeNode: TS.TypeNode | undefined;
    if (decl.type) tocTypeNode = decl.type;
    else if (decl.initializer && ts.isSatisfiesExpression(decl.initializer)) {
      tocTypeNode = decl.initializer.type;
    }
    if (!tocTypeNode || !ts.isTypeReferenceNode(tocTypeNode)) continue;
    if (!isTOCTypeName(ts, tocTypeNode.typeName)) continue;
    const typeArgNode = tocTypeNode.typeArguments?.[0];
    if (!typeArgNode) continue;
    const sigType = checker.getTypeFromTypeNode(typeArgNode);
    const eltSym = sigType.getProperty('Element');
    if (!eltSym) continue;
    const eltType = checker.getTypeOfSymbolAtLocation(eltSym, typeArgNode);
    if (eltType.flags & ts.TypeFlags.Unknown) return 'transparent';
    const tag = matchElementTypeToTag(eltType, elementTypeToTag);
    if (tag !== null) return tag;
  }
  return null;
}

// Recognize the bare type name `TOC` (and `TemplateOnlyComponent`, the
// long-form alias both `@ember/component/template-only` and
// `@glint/template/-private` re-export). Also handles qualified names like
// `Ember.TOC` — for those we match the rightmost identifier (`name.right`),
// since that's the actual type name. Doesn't follow imports: a project
// that aliases TOC to something else won't be resolved, which is fine —
// the component falls back to transparent.
function isTOCTypeName(ts: typeof TS, name: TS.EntityName): boolean {
  let id: TS.Identifier;
  if (ts.isIdentifier(name)) id = name;
  else if (ts.isQualifiedName(name)) id = name.right;
  else return false;
  return id.text === 'TOC' || id.text === 'TemplateOnlyComponent';
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
  const componentAttrMap = new Map<string, ComponentAttrs>();
  // Per-invocation consumer-side info: @args (for arg propagation) and
  // dotted-binding context (for `<S.Step>` curried-via-yield-hash
  // resolution).
  const { argsByLoc: consumerArgsByLoc, dottedBindings } = buildConsumerInfo(
    filename,
    contents,
  );
  // Populated as we resolve binder invocations during walkMapping. Keys
  // by binder's line:col; value is its TemplateSource. Lets dotted-
  // child resolution reach binders defined in the consumer file
  // itself (no import to follow). Initialized lazy: only created if
  // the consumer has any dotted invocations needing it.
  const binderSourceByKey = new Map<string, ReturnType<typeof findTemplateSource>>();
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
      // Run the canonical resolver: walks the component's template AST,
      // handles polymorphic-tag chain, PascalCase wrapper recursion,
      // conditional convergence, and yield-ancestor analysis in one
      // pass. Replaces the previous six-path resolution sprawl
      // (leaf-fallback, outer-wrapper override, polymorphic chain,
      // classic-.hbs fallback, import-based outer-wrapper fallback,
      // dual-tag heuristic).
      if (emitCall) {
        const declFile = findComponentDeclSourceFile(ts, checker, emitCall);
        // Skip the same-package outer-wrapper override when the
        // declaration ISN'T a top-level statement in `declFile` —
        // typically a let-block-param (`{{let @x as |Group|}}` becomes
        // `const [Group] = ...` inside the template-to-typescript
        // output). For these, declFile is the consumer file and
        // walking its outer `<template>` block returns whatever
        // happens to be at the file's root (often unrelated to what
        // `Group` actually renders).
        const symbol = getComponentSymbolFromEmitCall(ts, checker, emitCall);
        const decl = symbol?.declarations?.[0];
        const isTopLevel = decl ? isTopLevelDeclaration(ts, decl) : false;
        const componentName = node.parent.sourceNode.tag;

        // Dotted invocation `<S.Step>` from a `<Binder as |S|>` block:
        // resolve via the binder's `{{yield (hash Step=...)}}` chain.
        const dottedBinding = dottedBindings.get(key);
        if (dottedBinding) {
          let binderSource = binderSourceByKey.get(dottedBinding.binderKey) ?? null;
          if (!binderSource) {
            binderSource = findTemplateSource({
              consumerFile: filename,
              componentName: dottedBinding.binderTag,
              ts,
            });
          }
          if (binderSource) {
            const resolution = resolveYieldHashBinding({
              parentSource: binderSource,
              hashKey: dottedBinding.hashKey,
              parentArgs: dottedBinding.binderArgs,
              ts,
            });
            applyResolution(componentTagMap, componentAttrMap, key, resolution);
          }
        } else if (declFile && isTopLevel) {
          // Skip non-top-level decls (let-block-params): walking their
          // declaring file's template returns whatever's at the file's
          // root, unrelated to what the binding renders.
          const declRange = decl ? { start: decl.getStart(), end: decl.getEnd() } : null;
          const source = findTemplateSource({
            declFile,
            declRange,
            consumerFile: filename,
            componentName,
            ts,
          });
          // Cache for any dotted-children that name this invocation as
          // their binder. Accept null too — a transparent binder result
          // still belongs to this invocation, no point re-querying.
          binderSourceByKey.set(key, source);
          if (source) {
            const consumerArgs = consumerArgsByLoc.get(key) ?? new Map();
            const resolution = resolveTemplate(source, { consumerArgs, ts });
            applyResolution(componentTagMap, componentAttrMap, key, resolution);
          }
        } else {
          // Cross-package barrel: TS resolved through a re-export and
          // we can't reach the source via decl. Fall back to consumer-
          // side import resolution.
          const source = findTemplateSource({
            consumerFile: filename,
            componentName,
            ts,
          });
          if (source) {
            const consumerArgs = consumerArgsByLoc.get(key) ?? new Map();
            const resolution = resolveTemplate(source, { consumerArgs, ts });
            applyResolution(componentTagMap, componentAttrMap, key, resolution);
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

// Recover the de-aliased symbol of the component invoked by an
// emitComponent call. Glint's rewrite emits invocations as
//   __glintDSL__.emitComponent(__glintDSL__.resolve(Comp)({...}))
// so we navigate the AST: emitCall.arguments[0] is the resolve()(...)
// call, whose expression is resolve(Comp), whose first argument is the
// component reference. Aliased imports (the common case) are de-aliased
// via `checker.getAliasedSymbol` to land on the original declaration.
//
// Shared by `findComponentDeclSourceFile` and
// `resolveElementFromTOCDeclaration` — they both need the same symbol;
// keeping the AST navigation in one place means callers stay in sync if
// Glint's emitted shape changes.
function getComponentSymbolFromEmitCall(
  ts: typeof TS,
  checker: TS.TypeChecker,
  emitCall: TS.CallExpression,
): TS.Symbol | null {
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
  return symbol;
}

// Resolve the source file containing a component's declaration.
function findComponentDeclSourceFile(
  ts: typeof TS,
  checker: TS.TypeChecker,
  emitCall: TS.CallExpression,
): string | null {
  const symbol = getComponentSymbolFromEmitCall(ts, checker, emitCall);
  const decl = symbol?.declarations?.[0];
  if (!decl) return null;
  return decl.getSourceFile().fileName;
}

// True when the component reference's declaration is a top-level
// statement in its source file (e.g. `const X: TOC<S> = <template>`),
// rather than an inner-scope binding (e.g. a let-block-param emitted
// as `const [Group] = ...` inside the template-to-typescript output).
//
// Why we need this: the outer-wrapper override walks the declaration
// file's first `<template>` block to find a wrapping native tag.
// That's correct for top-level component declarations whose template
// IS the file's first block, but produces wrong results for inner-
// scope bindings — a `{{let @groupComponent as |Group|}}` would resolve
// `<Group>`'s declFile back to the consumer file, and walking the
// consumer's first `<template>` block returns whatever wrapper
// happens to be there (often `<ul>` for a power-select-options-style
// recursive template), not what `Group` actually renders.
function isTopLevelDeclaration(ts: typeof TS, decl: TS.Declaration): boolean {
  // VariableDeclaration → VariableDeclarationList → VariableStatement
  // → SourceFile (when top-level).
  // ClassDeclaration / FunctionDeclaration etc. → directly child of
  // SourceFile.
  let node: TS.Node | undefined = decl;
  while (node) {
    if (
      node.kind === ts.SyntaxKind.VariableStatement ||
      node.kind === ts.SyntaxKind.ClassDeclaration ||
      node.kind === ts.SyntaxKind.FunctionDeclaration ||
      node.kind === ts.SyntaxKind.InterfaceDeclaration ||
      node.kind === ts.SyntaxKind.TypeAliasDeclaration ||
      node.kind === ts.SyntaxKind.ExportAssignment
    ) {
      // Only top-level if the parent IS the SourceFile.
      return node.parent?.kind === ts.SyntaxKind.SourceFile;
    }
    node = node.parent;
  }
  return false;
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
