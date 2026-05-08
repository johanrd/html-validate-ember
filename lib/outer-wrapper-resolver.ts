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
import { preprocess, traverse } from '@glimmer/syntax';
import type { AST } from '@glimmer/syntax';

import { isNativeTag } from '../blank.js';

const preprocessor = new Preprocessor();

// Cache resolved outer-wrappers per absolute filename. Process-
// lifetime; cleared via `_clearOuterWrapperCache` for tests.
const cache = new Map<string, string | null>();

// Cap recursion depth — components in the wild are unlikely to nest
// wrappers more than a few levels, and a higher cap risks pathological
// performance on cycles or accidental fan-out.
const MAX_DEPTH = 8;

// Find the topmost ElementNode in a template — the OUTERMOST wrapper.
// Returns null if the template has no element children (e.g. just
// `{{yield}}` or text).
function findOutermostElement(ast: AST.Template): AST.ElementNode | null {
  let outermost: AST.ElementNode | null = null;
  // We want the FIRST top-level element only, not nested children.
  // `traverse`'s `ElementNode.enter` would visit every descendant;
  // bail after the first hit at depth 0.
  let foundAtDepth0 = false;
  traverse(ast, {
    ElementNode: {
      enter(node) {
        if (foundAtDepth0) return;
        outermost = node;
        foundAtDepth0 = true;
      },
    },
  });
  return outermost;
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
// an absolute file path, walking `node_modules` upward from `fromFile`
// and consulting package.json `exports` / `main`.
//
// Strategy: prefer SOURCE files (`src/<sub>.ts/.gts`) over compiled
// dist (`dist/<sub>.js`), so we can read the original `<template>`
// blocks. If `src/` doesn't exist, fall through to the package's
// declared exports.
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
      // Fall back to whatever the package's exports/main points to.
      // We don't fully resolve `exports` patterns — just probe a few
      // common shapes.
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

// Resolve the outermost native wrapper tag for the component declared
// in `filename`'s first `<template>` block. Recurses through nested
// PascalCase wrappers via local imports.
//
// Returns:
//   - tag name (e.g. 'li', 'div')  if a native wrapper is found.
//   - null                          if no native wrapper exists in the
//                                   template chain (e.g. all wrappers
//                                   are unresolvable PascalCase, or
//                                   template has no element root).
//
// Single-template-block assumption: most component files have one
// `<template>` block; multi-template files (helper exports + default)
// would need declaration-to-template matching. The first block is a
// reasonable default for the common case.
export function resolveOuterWrapperTag(filename: string): string | null {
  return resolveOuterWrapperTagInner(filename, new Set(), 0);
}

function resolveOuterWrapperTagInner(
  filename: string,
  visited: Set<string>,
  depth: number,
): string | null {
  if (depth > MAX_DEPTH) return null;
  if (visited.has(filename)) return null; // cycle guard
  const cached = cache.get(filename);
  if (cached !== undefined && depth === 0) return cached;
  visited.add(filename);

  let contents: string;
  try {
    contents = fs.readFileSync(filename, 'utf8');
  } catch {
    if (depth === 0) cache.set(filename, null);
    return null;
  }

  let blocks: ReturnType<Preprocessor['parse']>;
  try {
    blocks = preprocessor.parse(contents, { filename });
  } catch {
    if (depth === 0) cache.set(filename, null);
    return null;
  }

  for (const block of blocks) {
    if (block.tagName !== 'template') continue;
    let ast: AST.Template;
    try {
      ast = preprocess(block.contents);
    } catch {
      continue;
    }
    const outermost = findOutermostElement(ast);
    if (!outermost) continue;

    if (isNativeTag(outermost.tag)) {
      if (depth === 0) cache.set(filename, outermost.tag);
      return outermost.tag;
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
      if (depth === 0) cache.set(filename, recursed);
      return recursed;
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
): string | null {
  const sourceFile = resolveComponentImport(consumerFile, componentName);
  if (sourceFile === null) return null;
  return resolveOuterWrapperTagInner(sourceFile, new Set(), 0);
}

// Test-only.
export function _clearOuterWrapperCache(): void {
  cache.clear();
}
