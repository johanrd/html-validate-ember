// Outer-wrapper resolver: finds the OUTERMOST native HTML tag wrapping
// a component's content, by walking the component's `<template>` block
// and recursively resolving any non-native top-level wrapper.
//
// Why: a component declares `Element: HTMLAnchorElement` (Glint reads
// this as the leaf interactive type → 'a'), but its template wraps
// the anchor in a list-item:
//
//   <template>
//     <ListItem>
//       <a ...attributes>{{yield}}</a>
//     </ListItem>
//   </template>
//
// At runtime the outermost element is `<li>` (via ListItem's own
// template). When a consumer places this component under `<ul>`, the
// runtime DOM is `<ul><li><a>…</a></li></ul>` — legal. But our
// substitution puts `<a>` directly under `<ul>` and
// `element-permitted-content` FP-fires.
//
// This module walks `<ListItem>`'s template, finds it has root `<li>`,
// recurses no further, and returns 'li'. The caller (lib/glint.ts)
// uses this to override leaf-interactive substitutions when an outer
// wrapper exists.
//
// Single-substitution trade-off: by preferring the outer wrapper we
// lose the inner-content semantics for these wrappers (e.g. a
// `<button>nested</button>` placed inside `<MyLink>` whose template
// wraps `<a>` in `<div>` won't fire `element-permitted-content` on
// `<button>`-under-`<a>` from the consumer's lint pass). The
// component's own template lints catch that on the addon side. The
// consumer-side parent-context FPs are the dominant pattern, so the
// trade-off favors outer.

import fs from 'node:fs';
import path from 'node:path';
import { Preprocessor } from 'content-tag';
import { preprocess } from '@glimmer/syntax';
import type { AST } from '@glimmer/syntax';

import { isNativeTag, stripBlockParamTypeAnnotations } from '../blank.js';
import { elementHasSplat, literalAttrs } from './component-attrs.js';

const preprocessor = new Preprocessor();

// Result of resolving a component's runtime DOM outermost tag, plus
// the attrs extracted from each level of the wrapper chain. Used by
// `lib/glint.ts` to override both `componentTagMap` and
// `componentAttrMap` when the component's leaf-style Element type
// (e.g. `<a>`) is hidden inside a wrapper structure that determines
// the consumer-side parent context.
//
// The `attrs` field is a UNION of attrs from each native level walked,
// with INNER (closer to the DOM) wins on conflicts. That mirrors
// Glimmer's runtime semantics: a wrapper's `<X ...attributes>` flows
// the consumer's attrs INTO `<X>`, but `<X>`'s own literal attrs
// (e.g. `<a href={{@href}}>`) are still applied and visible on the
// rendered DOM.
//
// Why we need this: a component declares `Element: HTMLAnchorElement`
// (Glint reads → 'a'); its template wraps the anchor in another
// component (`<HdsInteractive ...attributes>`); HdsInteractive's
// template renders `<a href={{@href}} ...>`. With only the
// outermost-splatted-root attrs, we'd inject `class` + `aria-label`
// (HdsInteractive-level) but miss `href`. html-validate's
// `aria-label-misuse` then fires because aria-label on an `<a>`
// without href is invalid.
export interface OuterWrapperResolution {
  tag: string;
  attrs: Record<string, string>;
  // Whether the template's actual native leaf has `...attributes` on
  // it. Forwarded from the leaf level so component-attr injection
  // logic that depends on splat-presence (e.g. `lookupComponentAttr`'s
  // builtin-fallback in blank.ts) sees the right value.
  hasSplat: boolean;
}

// Cache resolved outer-wrappers per absolute filename. Process-
// lifetime; cleared via `_clearOuterWrapperCache` for tests.
const cache = new Map<string, OuterWrapperResolution | null>();

// Cap recursion depth — components in the wild are unlikely to nest
// wrappers more than a few levels, and a higher cap risks pathological
// performance on cycles or accidental fan-out.
const MAX_DEPTH = 8;

// Find the OUTERMOST wrapper in a template — the element that
// determines the consumer-side parent context.
//
// Walk rules:
//   - DO descend through `BlockStatement` bodies (`{{#if}}/{{else}}`,
//     `{{#each}}`, etc.) so we can see top-level elements gated by
//     conditionals — e.g. HdsInteractive's
//     `{{#if @route}}<LinkTo>{{else if @href}}<a>{{else}}<button>{{/if}}`.
//   - DO NOT descend into `ElementNode` children: a child is INSIDE
//     a wrapper, not at the outermost level. `<ListItem><a>...</a>`
//     should yield `<ListItem>`, not `<a>`.
//   - SKIP dotted (`<this.X>`, `<F.Options>`) and slot-named
//     (`<:foo>`) elements — not statically resolvable. Keep walking
//     siblings / further branches.
//
// Among reachable candidates, prefer:
//   1. The first NATIVE element.
//   2. Else the first resolvable PascalCase wrapper.
//
// Returns null if no usable element exists.
function findOutermostElement(ast: AST.Template): AST.ElementNode | null {
  let firstNative: AST.ElementNode | null = null;
  let firstResolvableWrapper: AST.ElementNode | null = null;
  function isUnresolvable(tag: string): boolean {
    return tag.includes('.') || tag.startsWith(':');
  }
  function visit(stmts: ReadonlyArray<AST.Statement | AST.TopLevelStatement>): void {
    for (const stmt of stmts) {
      if (firstNative !== null) return;
      if (stmt.type === 'ElementNode') {
        if (isUnresolvable(stmt.tag)) continue;
        if (isNativeTag(stmt.tag)) {
          firstNative = stmt;
          return;
        }
        if (firstResolvableWrapper === null) firstResolvableWrapper = stmt;
        // Don't descend into ElementNode children — they're nested
        // content, not outermost candidates.
        continue;
      }
      if (stmt.type === 'BlockStatement') {
        visit(stmt.program.body);
        if (firstNative !== null) return;
        if (stmt.inverse) visit(stmt.inverse.body);
        continue;
      }
    }
  }
  visit(ast.body);
  return firstNative ?? firstResolvableWrapper;
}

// Resolve a PascalCase component name in `consumerFile`'s source to
// the absolute path of its `.gts/.gjs` source. Walks the imports in
// the file's text (regex-based — we don't pull in a full TS parser).
//
// Two import shapes are handled:
//   1. Relative import (`./foo.gts`) — resolve directly.
//   2. Package import (`@scope/pkg/components`) — resolve via
//      `node_modules` walk + package.json `exports`, then if the
//      resolved file is a barrel `.ts`, parse it for the re-export of
//      `componentName` and follow that.
//
// Returns null when:
//   - The import doesn't exist in the file.
//   - The import's path doesn't resolve to a readable file.
//   - The resolved file isn't a `.gts/.gjs` (after barrel-following).
function resolveComponentImport(consumerFile: string, componentName: string): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(consumerFile, 'utf8');
  } catch {
    return null;
  }
  // Match patterns:
  //   import X from '...';
  //   import X, { ... } from '...';
  //   import { X } from '...';
  //   import { X as Y } from '...';
  //   import { Y as X } from '...';
  const escName = componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Default-import pattern.
  const defaultRe = new RegExp(
    `import\\s+${escName}(?:\\s*,\\s*\\{[^}]*\\})?\\s+from\\s+['"]([^'"]+)['"]`,
    'm',
  );
  const defaultMatch = defaultRe.exec(contents);
  if (defaultMatch) {
    return resolveAnyImport(consumerFile, defaultMatch[1]!, componentName, /* defaultExport */ true);
  }
  // Named-import pattern, possibly aliased: { X } / { X as Y } / { Y as X }.
  const namedRe = new RegExp(
    `import\\s+(?:\\{[^}]*\\}|[A-Za-z_$][\\w$]*\\s*,\\s*\\{[^}]*\\})\\s+from\\s+['"]([^'"]+)['"]`,
    'g',
  );
  let namedMatch: RegExpExecArray | null;
  while ((namedMatch = namedRe.exec(contents)) !== null) {
    const fullStmt = namedMatch[0];
    const bracesMatch = /\{([^}]*)\}/.exec(fullStmt);
    if (!bracesMatch) continue;
    const names = bracesMatch[1]!.split(',').map((s) => s.trim());
    // For named imports, find the EXPORT name corresponding to the
    // local name `componentName`. `Foo as Bar` means: external export
    // `Foo`, local name `Bar`. If the consumer wrote `<Bar>`, we
    // follow the export `Foo` from the imported module.
    let exportName: string | null = null;
    for (const entry of names) {
      const aliasMatch = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(entry);
      if (aliasMatch) {
        if (aliasMatch[2] === componentName) {
          exportName = aliasMatch[1]!;
          break;
        }
      } else if (entry === componentName) {
        exportName = componentName;
        break;
      }
    }
    if (exportName !== null) {
      return resolveAnyImport(consumerFile, namedMatch[1]!, exportName, false);
    }
  }
  return null;
}

// Resolve an import (relative or package-style) to an absolute
// `.gts/.gjs` file, following barrel re-exports if the import lands
// on a `.ts` barrel.
//
// `exportName` is the name we're looking for IN THE IMPORTED MODULE
// (the export name, not the consumer's local alias).
// `defaultExport`: when true, we look for `default` re-export in
// barrels (typical for `import X from 'pkg/barrel'`).
function resolveAnyImport(
  fromFile: string,
  importSpec: string,
  exportName: string,
  defaultExport: boolean,
): string | null {
  let resolved: string | null;
  if (importSpec.startsWith('.')) {
    resolved = resolveImportPath(fromFile, importSpec);
  } else {
    resolved = resolvePackageImport(fromFile, importSpec);
  }
  if (resolved === null) return null;
  // If we landed on a `.gts/.gjs`, we're done — that's the source.
  if (resolved.endsWith('.gts') || resolved.endsWith('.gjs')) {
    return resolved;
  }
  // If we landed on a `.ts` (typically a barrel), parse for the
  // re-export of `exportName` and follow it.
  if (resolved.endsWith('.ts') && !resolved.endsWith('.d.ts')) {
    return followBarrelReExport(resolved, exportName, defaultExport);
  }
  return null;
}

// Resolve a package-style import (`@scope/pkg/sub` or `pkg/sub`) to
// an absolute file path. Walks `node_modules` upward from `fromFile`
// to find the package root, then probes a fixed set of source-style
// paths for the sub-path:
//
//   1. `src/<sub>.{gts,gjs,ts}`  — most v2 addon source layouts.
//   2. `src/<sub>/index.{gts,gjs,ts}` — directory imports.
//   3. (no `<sub>`) `src/index.{gts,gjs,ts}`.
//   4. Bare `<sub>.{ts,gts}` / `<sub>/index.ts` at the package root,
//      for packages that don't have a `src/` layer.
//
// Note: this does NOT read `package.json` `exports` / `main`. We
// prefer SOURCE files (so we can read the original `<template>`
// blocks) over whatever the package declares for runtime use, and
// the source layout for v2 addons is conventional enough that the
// hardcoded probes hit. If a package uses an unconventional source
// layout this resolver returns null and the caller falls back to
// other paths (Glint TS resolution, classic-by-name).
function resolvePackageImport(fromFile: string, importSpec: string): string | null {
  // Split into `<package-name>` and `<sub-path>` (e.g.
  // `@scope/pkg/foo/bar` → `@scope/pkg`, `foo/bar`;
  // `pkg/foo` → `pkg`, `foo`; bare `pkg` → `pkg`, '').
  let pkgName: string;
  let subPath: string;
  if (importSpec.startsWith('@')) {
    const slashIdx = importSpec.indexOf('/');
    if (slashIdx < 0) return null;
    const secondSlash = importSpec.indexOf('/', slashIdx + 1);
    if (secondSlash < 0) {
      pkgName = importSpec;
      subPath = '';
    } else {
      pkgName = importSpec.slice(0, secondSlash);
      subPath = importSpec.slice(secondSlash + 1);
    }
  } else {
    const slashIdx = importSpec.indexOf('/');
    if (slashIdx < 0) {
      pkgName = importSpec;
      subPath = '';
    } else {
      pkgName = importSpec.slice(0, slashIdx);
      subPath = importSpec.slice(slashIdx + 1);
    }
  }
  // Walk up looking for node_modules/<pkgName>.
  let dir = path.dirname(fromFile);
  while (true) {
    const pkgRoot = path.join(dir, 'node_modules', pkgName);
    if (fs.existsSync(pkgRoot)) {
      // Try SOURCE first: src/<sub>.{ts,gts,gjs} or src/<sub>/index.*
      if (subPath) {
        for (const ext of ['.gts', '.gjs', '.ts']) {
          const candidate = path.join(pkgRoot, 'src', subPath + ext);
          if (fs.existsSync(candidate)) return candidate;
        }
        for (const ext of ['.gts', '.gjs', '.ts']) {
          const candidate = path.join(pkgRoot, 'src', subPath, 'index' + ext);
          if (fs.existsSync(candidate)) return candidate;
        }
      } else {
        for (const ext of ['.gts', '.gjs', '.ts']) {
          const candidate = path.join(pkgRoot, 'src', 'index' + ext);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
      // Fall back to a few bare paths at the package root for
      // packages that don't have a `src/` layer.
      if (subPath) {
        for (const sub of [`${subPath}.ts`, `${subPath}.gts`, `${subPath}/index.ts`]) {
          const candidate = path.join(pkgRoot, sub);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Parse a `.ts` barrel for `export { default as <exportName> } from '...'`
// or `export { <exportName> } from '...'` and follow the path.
//
// We use simple regex extraction; the barrel files we care about are
// generated re-export files, so the syntax is regular.
function followBarrelReExport(
  barrelFile: string,
  exportName: string,
  defaultExport: boolean,
): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(barrelFile, 'utf8');
  } catch {
    return null;
  }
  const escName = exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `export { default as <exportName> } from '<path>';` (when defaultExport=true,
  // also matches `export { default as <exportName>, ... } from '<path>';`).
  // For named exports (defaultExport=false), match `export { <exportName>` or
  // `export { ..., <exportName>` — the export name appears verbatim.
  const exportRe = defaultExport
    ? new RegExp(
        `export\\s+\\{[^}]*\\bdefault\\s+as\\s+${escName}\\b[^}]*\\}\\s+from\\s+['"]([^'"]+)['"]`,
        'm',
      )
    : new RegExp(
        `export\\s+\\{[^}]*\\b${escName}\\b[^}]*\\}\\s+from\\s+['"]([^'"]+)['"]`,
        'm',
      );
  const m = exportRe.exec(contents);
  if (!m) return null;
  // Resolve the re-exported path relative to the barrel's location.
  return resolveAnyImport(barrelFile, m[1]!, exportName, defaultExport);
}

// Resolve a relative import path to an absolute `.gts/.gjs` file.
// Doesn't follow package imports (those go through node_modules and
// are typically barrels we can't statically traverse without TS).
function resolveImportPath(fromFile: string, importSpec: string): string | null {
  if (!importSpec.startsWith('.')) return null;
  const fromDir = path.dirname(fromFile);
  // Try the literal path first (in case it ends in .gts/.gjs).
  const literal = path.resolve(fromDir, importSpec);
  if (literal.endsWith('.gts') || literal.endsWith('.gjs')) {
    if (fs.existsSync(literal)) return literal;
  }
  // Try appending each extension.
  for (const ext of ['.gts', '.gjs']) {
    const candidate = literal + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  // Try as a directory with an index file.
  for (const ext of ['.gts', '.gjs']) {
    const candidate = path.join(literal, 'index' + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Resolve the outermost native wrapper tag and accumulated attrs for
// the component declared in `filename`'s first `<template>` block.
// Recurses through nested PascalCase wrappers via local imports.
//
// Returns:
//   - {tag, attrs} if a native wrapper is found anywhere in the chain.
//     `attrs` is the UNION of attrs from each level walked (literal and
//     mustache-bound), inner-wins on conflicts.
//   - null         if no native wrapper exists in the template chain.
//
// Single-template-block assumption: most component files have one
// `<template>` block; multi-template files (helper exports + default)
// would need declaration-to-template matching. The first block is a
// reasonable default for the common case.
export function resolveOuterWrapperTag(filename: string): OuterWrapperResolution | null {
  return resolveOuterWrapperTagInner(filename, new Set(), 0);
}

function resolveOuterWrapperTagInner(
  filename: string,
  visited: Set<string>,
  depth: number,
): OuterWrapperResolution | null {
  if (depth > MAX_DEPTH) return null;
  if (visited.has(filename)) return null; // cycle guard
  // The result for a given `filename` is deterministic (it walks the
  // file's first `<template>` block and recurses through its
  // wrappers), so it's safe to consult/populate the cache at any
  // depth. The cycle guard via `visited` still prevents us from
  // recursing into a file that's currently being walked higher up
  // the call stack — a separate concern from cross-call caching.
  const cached = cache.get(filename);
  if (cached !== undefined) return cached;
  visited.add(filename);

  let contents: string;
  try {
    contents = fs.readFileSync(filename, 'utf8');
  } catch {
    cache.set(filename, null);
    return null;
  }

  let blocks: ReturnType<Preprocessor['parse']>;
  try {
    blocks = preprocessor.parse(contents, { filename });
  } catch {
    cache.set(filename, null);
    return null;
  }

  for (const block of blocks) {
    if (block.tagName !== 'template') continue;
    let ast: AST.Template;
    try {
      // Match `blank.ts`'s template-parsing preamble: strip TS-style
      // block-param type annotations (`as |x: T|`) so Glimmer's
      // parser accepts them, and use `mode: 'codemod'` for source
      // fidelity. Without these, a typed-block-param template would
      // throw and we'd silently miss wrapper/attr resolution —
      // reintroducing the FPs this resolver is meant to fix.
      ast = preprocess(stripBlockParamTypeAnnotations(block.contents), { mode: 'codemod' });
    } catch {
      continue;
    }
    const outermost = findOutermostElement(ast);
    if (!outermost) continue;

    // Extract attrs at THIS level — directly off the outermost
    // element returned by `findOutermostElement`. Reading attrs off a
    // different element (e.g. via `extractSplattedRootFromTemplate`'s
    // own splatted-root selection) could miss attrs on the actual
    // chain wrapper.
    const levelAttrs = literalAttrs(outermost);

    if (isNativeTag(outermost.tag)) {
      const result = {
        tag: outermost.tag,
        attrs: levelAttrs,
        hasSplat: elementHasSplat(outermost),
      };
      cache.set(filename, result);
      return result;
    }

    // Skip dotted invocations (`<This.Foo>`, `<F.Options>`) — those
    // are curried sub-components or instance refs, not statically
    // resolvable via local imports. Treat as unresolvable wrapper.
    if (outermost.tag.includes('.')) continue;
    // Skip named-block syntax (`<:slot>`).
    if (outermost.tag.startsWith(':')) continue;

    // PascalCase wrapper — try to resolve via local import.
    const importPath = resolveComponentImport(filename, outermost.tag);
    if (!importPath) continue;
    const recursed = resolveOuterWrapperTagInner(importPath, visited, depth + 1);
    if (recursed !== null) {
      // Merge attrs: outer wrapper level's attrs UNDER the recursed
      // attrs (inner wins on conflicts — closer to the rendered DOM).
      const merged = { ...levelAttrs, ...recursed.attrs };
      const result = {
        tag: recursed.tag,
        attrs: merged,
        hasSplat: recursed.hasSplat,
      };
      cache.set(filename, result);
      return result;
    }
  }

  if (depth === 0) cache.set(filename, null);
  return null;
}

// Resolve outer-wrapper for a component invoked from `consumerFile`
// when Glint's TS-based `findComponentDeclSourceFile` returned null
// (typically: the component is imported through a package-level
// barrel and TS can't trace the symbol back to its source file).
//
// We bypass TS by looking up the `import` statement in the consumer's
// source, resolving the path (relative or package-style), following
// barrel re-exports, and then walking the component's template chain.
//
// Returns the outermost native wrapper tag, or null if we can't
// locate the source.
export function resolveOuterWrapperFromConsumerImport(
  consumerFile: string,
  componentName: string,
): OuterWrapperResolution | null {
  const sourceFile = resolveComponentImport(consumerFile, componentName);
  if (sourceFile === null) return null;
  return resolveOuterWrapperTagInner(sourceFile, new Set(), 0);
}

// Test-only.
export function _clearOuterWrapperCache(): void {
  cache.clear();
}
