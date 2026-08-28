// TypeScript 5/6 backend: the host project's `typescript` as an in-process
// library, Glint's `rewriteModule` for the `.gts` → TypeScript transform,
// and a compiler host that serves the rewritten text as virtual `.ts`
// files. Sites come from Glint's own Glimmer-AST mapping tree.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';

import { isComponentTag } from '../../blank.js';
import { readCache, writeCache } from '../cache.js';
import type {
  OpenedFile,
  PreloadProgress,
  PreloadStats,
  TemplateSite,
  TsSyntax,
  TypeBackend,
  TypeLike,
} from './types.js';

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
export interface Ts6Deps {
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
// Module-level state — `depsByRoot` and the per-tsconfig backends are
// shared across calls in the same Node process. Safe under the
// single-threaded CLI / Node main-thread assumption; would need
// per-thread isolation if ever invoked concurrently from worker_threads.
const depsByRoot = new Map<string, Ts6Deps | null>();

export function loadTs6Deps(filename: string): Ts6Deps | null {
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
  let deps: Ts6Deps | null;
  try {
    const ts = projectReq('typescript') as typeof TS;
    if (typeof ts.createProgram !== 'function') {
      throw new Error(`'typescript' resolved to ${ts.version}, which has no library API`);
    }
    const transform = projectReq('@glint/ember-tsc/transform/index') as {
      rewriteModule: Ts6Deps['rewriteModule'];
    };
    const config = projectReq('@glint/ember-tsc') as {
      createDefaultConfig: Ts6Deps['createDefaultConfig'];
    };
    deps = {
      ts,
      rewriteModule: transform.rewriteModule,
      createDefaultConfig: config.createDefaultConfig,
    };
  } catch (err) {
    process.stderr.write(
      `[html-validate-ember] @glint/ember-tsc found but Glint integration is unavailable: ${
        err instanceof Error ? err.message : String(err)
      }. Keep typescript 5/6 installed; TypeScript 7 has no library API.\n`,
    );
    deps = null;
  }
  depsByRoot.set(projectRoot, deps);
  return deps;
}

export function ts6Syntax(ts: typeof TS): TsSyntax {
  return {
    SyntaxKind: ts.SyntaxKind,
    TypeFlags: ts.TypeFlags,
    SymbolFlags: ts.SymbolFlags,
    ObjectFlags: ts.ObjectFlags,
    parseFile: (fileName, contents, kind) =>
      ts.createSourceFile(
        fileName,
        contents,
        ts.ScriptTarget.Latest,
        true,
        kind === 'js' ? ts.ScriptKind.JS : ts.ScriptKind.TS,
      ),
    forEachChild: (node, visit) => {
      ts.forEachChild(node, visit);
    },
    isBinaryExpression: ts.isBinaryExpression,
    isCallExpression: ts.isCallExpression,
    isClassDeclaration: ts.isClassDeclaration,
    isClassExpression: ts.isClassExpression,
    isEnumDeclaration: ts.isEnumDeclaration,
    isExportDeclaration: ts.isExportDeclaration,
    isGetAccessor: ts.isGetAccessor,
    isIdentifier: ts.isIdentifier,
    isImportDeclaration: ts.isImportDeclaration,
    isInterfaceDeclaration: ts.isInterfaceDeclaration,
    isNamedExports: ts.isNamedExports,
    isNamedImports: ts.isNamedImports,
    isObjectBindingPattern: ts.isObjectBindingPattern,
    isPropertyAccessExpression: ts.isPropertyAccessExpression,
    isPropertyDeclaration: ts.isPropertyDeclaration,
    isPropertySignature: ts.isPropertySignature,
    isQualifiedName: ts.isQualifiedName,
    isReturnStatement: ts.isReturnStatement,
    isSatisfiesExpression: ts.isSatisfiesExpression,
    isStringLiteral: ts.isStringLiteral,
    isStringLiteralLike: ts.isStringLiteralLike,
    isTypeReferenceNode: ts.isTypeReferenceNode,
    isVariableDeclaration: ts.isVariableDeclaration,
    isVariableStatement: ts.isVariableStatement,
    // The checker hands out `TS.Type` objects; `TypeLike` is their
    // structural subset, so the narrowing methods are reached by
    // widening back to the concrete type here.
    declarations: (symbol) => (symbol as TS.Symbol).declarations ?? [],
    aliasTypeArguments: (type: TypeLike) => (type as TS.Type).aliasTypeArguments,
    unionMembers: (type: TypeLike) => {
      const t = type as TS.Type;
      return t.isUnion() ? t.types : null;
    },
    stringLiteralValue: (type: TypeLike) => {
      const t = type as TS.Type;
      return t.isStringLiteral() ? t.value : null;
    },
  };
}

interface ProgramContext {
  parsed: TS.ParsedCommandLine;
  virtualFiles: Map<string, string>;
  compilerHost: TS.CompilerHost;
  program: TS.Program | null;
  extraRootNames: string[];
  lastRootKey?: string;
}

function locKey(line: number, column: number): string {
  return `${line}:${column}`;
}

// Sites in the order Glint's mapping tree visits them: an element's
// PathExpression before its attributes, parents before children.
function collectSites(transformed: GlintRewriteResult): TemplateSite[] {
  const sites: TemplateSite[] = [];
  function walk(node: GlimmerAstMappingNode | undefined, spanTransformedStart: number): void {
    if (!node) return;
    const sourceNode = node.sourceNode;
    if (
      sourceNode?.type === 'MustacheStatement' &&
      node.parent?.sourceNode?.type === 'AttrNode' &&
      node.transformedRange &&
      sourceNode.loc?.start
    ) {
      sites.push({
        kind: 'attr-mustache',
        key: locKey(sourceNode.loc.start.line, sourceNode.loc.start.column),
        range: {
          start: node.transformedRange.start + spanTransformedStart,
          end: node.transformedRange.end + spanTransformedStart,
        },
      });
    }
    if (
      sourceNode?.type === 'PathExpression' &&
      node.parent?.sourceNode?.type === 'ElementNode' &&
      node.parent.sourceNode.tag &&
      isComponentTag(node.parent.sourceNode.tag) &&
      node.transformedRange &&
      node.parent.sourceNode.loc?.start
    ) {
      const elementLoc = node.parent.sourceNode.loc.start;
      sites.push({
        kind: 'component',
        key: locKey(elementLoc.line, elementLoc.column),
        tag: node.parent.sourceNode.tag,
        range: {
          start: node.transformedRange.start + spanTransformedStart,
          end: node.transformedRange.end + spanTransformedStart,
        },
      });
    }
    for (const child of node.children ?? []) {
      walk(child, spanTransformedStart);
    }
  }
  for (const span of transformed.correlatedSpans) {
    if (span.glimmerAstMapping) {
      walk(span.glimmerAstMapping, span.transformedStart);
    }
  }
  return sites;
}

export function createTs6Backend(deps: Ts6Deps, tsconfigPath: string): TypeBackend {
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
  //
  // A project on the TypeScript 7 content mapper may have dropped
  // `ember-source/types` and `@glint/ember-tsc/types` from `types` (the
  // mapper references them itself). This program needs them regardless,
  // so they are always added when they resolve.
  const projectReq = createRequire(path.resolve(projectRoot, 'package.json'));
  const extraRootNames: string[] = [];
  const remainingTypes: string[] = [];
  const declaredTypes = parsed.options.types ?? [];
  const glintTypes = ['ember-source/types', '@glint/ember-tsc/types'].filter((t) => !declaredTypes.includes(t));
  for (const t of [...declaredTypes, ...glintTypes]) {
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
      // not resolvable via Node — leave declared entries to TS's own lookup
      if (glintTypes.includes(t)) continue;
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
    parsed,
    virtualFiles,
    // Filled in below — declare the property up front so we can reference
    // `ctx` inside the host shim closures without TS complaining.
    compilerHost: undefined as unknown as TS.CompilerHost,
    program: null,
    extraRootNames,
  };

  function rewrite(filename: string, contents: string): GlintRewriteResult | null {
    const glintConfig = deps.createDefaultConfig(ts, projectRoot);
    return deps.rewriteModule(ts, { script: { filename, contents } }, glintConfig.environment);
  }

  // Rewrite a .gts file via Glint's rewriteModule and return the transformed
  // TypeScript source. Returns null on parse failure. Result is suitable as a
  // virtual .ts file for the TS program.
  function rewriteGtsToShadow(gtsPath: string): string | null {
    let contents: string;
    try {
      contents = fs.readFileSync(gtsPath, 'utf8');
    } catch {
      return null;
    }
    try {
      return rewrite(gtsPath, contents)?.transformedContents ?? null;
    } catch {
      return null;
    }
  }

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
      const rewritten = rewriteGtsToShadow(gtsPath);
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
        const rewritten = rewriteGtsToShadow(gtsPath);
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

  function ensureProgram(): TS.Program {
    // Build the rootNames set. Cheap re-walk every call.
    const rootNames = [...new Set([...virtualFiles.keys(), ...parsed.fileNames, ...extraRootNames])];
    // Skip ts.createProgram when rootNames haven't changed since last call —
    // big cold-run speedup paired with `preload`, which populates
    // virtualFiles up-front so subsequent `open` calls don't each trigger
    // an incremental rebuild. (Even with `oldProgram`, each createProgram
    // costs hundreds of ms per file × N files = real time.)
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

  function preload(filenames: readonly string[], onProgress?: (p: PreloadProgress) => void): PreloadStats {
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
      if (readCache(filename, contents, tsconfigPath, 'ts6')) {
        cached++;
        onProgress?.({ done, total: filenames.length, phase: 'rewrite' });
        continue;
      }
      let transformed: GlintRewriteResult | null;
      try {
        transformed = rewrite(filename, contents);
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
        writeCache(filename, contents, tsconfigPath, 'ts6', {
          attrTypeMap: new Map(),
          componentTagMap: new Map(),
          componentAttrMap: new Map(),
        });
        skips.rewriteEmpty.push({ file: filename });
        onProgress?.({ done, total: filenames.length, phase: 'rewrite' });
        continue;
      }
      const tsFilename = filename.replace(/\.(gts|gjs)$/, '.ts');
      virtualFiles.set(path.normalize(tsFilename), transformed.transformedContents);
      loaded++;
      onProgress?.({ done, total: filenames.length, phase: 'rewrite' });
    }
    if (loaded > 0) {
      onProgress?.({ done: filenames.length, total: filenames.length, phase: 'program' });
      // Single program build with everything seeded. Skipped when loaded
      // is 0 — no virtualFiles changed, no program needed up-front (the
      // per-file `open` path triggers a program build on demand for any
      // file that misses cache).
      ensureProgram();
    }
    // Always emit `done` so the caller's TTY progress line (if any) gets
    // cleared — even on the all-cached path where no `program` phase
    // fired. Without this, the throttled "template 1/N" rewrite line
    // stays on screen and the summary writes right after it.
    onProgress?.({ done: filenames.length, total: filenames.length, phase: 'done' });
    return { backend: 'ts6', loaded, cached, skipped: skippedTotal(), skips };
  }

  function open(filename: string, contents: string): OpenedFile | 'no-template' | null {
    let transformed: GlintRewriteResult | null;
    try {
      transformed = rewrite(filename, contents);
    } catch {
      return null;
    }
    if (!transformed) {
      return 'no-template';
    }
    // Stash the rewritten content for the file being validated. Cross-file
    // .gts imports get handled lazily by the compilerHost shims.
    const tsFilename = filename.replace(/\.(gts|gjs)$/, '.ts');
    virtualFiles.set(path.normalize(tsFilename), transformed.transformedContents);
    const program = ensureProgram();
    const sourceFile = program.getSourceFile(tsFilename);
    if (!sourceFile) {
      return null;
    }
    return {
      sourceFile,
      checker: program.getTypeChecker(),
      program: {
        getSourceFile: (name) => program.getSourceFile(name),
        getSourceFileNames: () => program.getSourceFiles().map((f) => f.fileName),
      },
      sites: collectSites(transformed),
      originalRange: (node) => ({ start: node.getStart(), end: node.getEnd() }),
    };
  }

  return {
    kind: 'ts6',
    tsconfigPath,
    projectRoot,
    syntax: ts6Syntax(ts),
    preload,
    open,
    dispose: () => {
      ctx.program = null;
      virtualFiles.clear();
    },
  };
}
