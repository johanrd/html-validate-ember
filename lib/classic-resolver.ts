// Classic Ember component resolver — by-name lookup in node_modules.
//
// Classic `.hbs` templates resolve PascalCase components through Ember's
// container resolver: `<EsCard>` corresponds to addon-installed
// `es-card.hbs` somewhere under `node_modules/<addon>/{addon|app}/`. No
// JS `import` is involved (unlike `.gts` which goes through Glint).
//
// PR #19's `resolveAddonHbsTemplate` walks JS imports — that path is
// dead in `.hbs` files. This module fills the gap: walk the template
// AST, find PascalCase tags, look up by kebab-case name in node_modules
// addons, parse the addon's component template, return its splatted-
// root tag.
//
// Cache:
//   - In-memory per-(consumer-dir, kebab-name) → ComponentAttrs.
//     Keyed off the consumer file's directory rather than a resolved
//     node_modules root: cheap to compute, and the lookup is already
//     local (we don't repeat the upward walk on a hit). Trade-off: two
//     consumers in different directories under the same node_modules
//     re-do the addon scan; tolerated because the scan itself is bounded
//     by `existsSync` probes per addon, and the cost is paid once per
//     (consumer-dir, kebab-name) pair for the rest of the process.
//     Process-lifetime; `_clearClassicResolverCache` is exported for
//     manual reset if a future test ever needs it.
//   - Negatives are NOT cached: an addon installed mid-session would
//     otherwise stay invisible until process restart. Negative path is
//     cheap (regex + a handful of existsSync up to filesystem root).

import fs from 'node:fs';
import path from 'node:path';
import { traverse } from '@glimmer/syntax';
import type { AST } from '@glimmer/syntax';

import { isNativeTag } from '../blank.js';
import type { ComponentAttrs } from './builtin-components.js';
import { extractSplattedRootFromTemplate } from './component-attrs.js';

const cache = new Map<string, ComponentAttrs>();

// Pre-filter cache for `findClassicComponent`: per absolute package
// path → "is this an Ember addon?" (`true`/`false`). Only addons ship
// classic component templates at the canonical `addon/`-prefixed
// paths, so probing 3 file paths × every package on every PascalCase
// lookup is wasted IO on large `node_modules`. We read each package's
// `package.json` once (per process) and cache the verdict.
//
// "Is an Ember addon" check: package.json has either
//   - `keywords` containing `'ember-addon'`, OR
//   - an `ember-addon` field (object).
//
// Both patterns are conventional v1-addon markers. v2 addons use
// different layouts that classic-by-name resolution doesn't target
// anyway.
const isAddonCache = new Map<string, boolean>();

function isEmberAddonPackage(pkgRoot: string): boolean {
  const cached = isAddonCache.get(pkgRoot);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
      keywords?: unknown;
      'ember-addon'?: unknown;
    };
    const kws = pkgJson.keywords;
    const hasKeyword = Array.isArray(kws) && kws.includes('ember-addon');
    const hasField = typeof pkgJson['ember-addon'] === 'object' && pkgJson['ember-addon'] !== null;
    result = hasKeyword || hasField;
  } catch {
    // Missing / unparseable package.json → not an addon for our purposes.
  }
  isAddonCache.set(pkgRoot, result);
  return result;
}

// Components our blank-step handles via the builtin map (not by-name
// resolution). Skip these — they'd shadow the builtin substitution.
const BUILTIN_COMPONENT_NAMES: ReadonlySet<string> = new Set([
  'Input',
  'Textarea',
  'LinkTo',
]);

// PascalCase → kebab-case. `EsCard` → `es-card`, `TabButton` → `tab-button`,
// `XMLHttpRequest` → `xml-http-request` (acronyms collapse correctly).
function pascalCaseToKebab(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

// Probe an addon directory for a component template by kebab-name.
// Returns the parsed splatted-root or null. Tries the three canonical
// classic-Ember component template paths in the same order as
// `lib/glint.ts:resolveAddonHbsTemplate` so `.hbs` and `.gts`
// consumers resolve identically when an addon ships templates in
// multiple paths.
function tryProbeAddon(addonRoot: string, kebabName: string): ComponentAttrs | null {
  for (const sub of [
    `addon/templates/components/${kebabName}.hbs`,
    `app/components/${kebabName}.hbs`,
    `addon/components/${kebabName}.hbs`,
  ]) {
    const hbsPath = path.join(addonRoot, sub);
    if (!fs.existsSync(hbsPath)) continue;
    let contents: string;
    try {
      contents = fs.readFileSync(hbsPath, 'utf8');
    } catch {
      continue;
    }
    return extractSplattedRootFromTemplate(contents);
  }
  return null;
}

// Look up `kebabName` in every addon under each `node_modules/` walked
// up from the consumer file. Returns the first match. Native-tag-only
// guard mirrors PR #19's `resolveAddonHbsTemplate` behavior.
function findClassicComponent(consumerFile: string, kebabName: string): ComponentAttrs | null {
  const cacheKey = `${path.dirname(consumerFile)}\0${kebabName}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  let dir = path.dirname(consumerFile);
  for (;;) {
    const nodeModules = path.join(dir, 'node_modules');
    if (fs.existsSync(nodeModules)) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(nodeModules, { withFileTypes: true });
      } catch {
        entries = [];
      }
      // Sort by name for deterministic resolution: `fs.readdirSync`
      // returns entries in filesystem order, which varies across OS
      // and filesystems. When two addons ship the same kebab-cased
      // template, sort order picks a stable winner.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        // pnpm uses symlinks for packages — `isDirectory()` returns
        // false on a symlink, so accept symlinks too. The lookup below
        // uses `fs.existsSync` which transparently follows links.
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.name.startsWith('@')) {
          // Scoped package — recurse one level.
          const scopeRoot = path.join(nodeModules, entry.name);
          let scopedEntries: fs.Dirent[];
          try {
            scopedEntries = fs.readdirSync(scopeRoot, { withFileTypes: true });
          } catch {
            continue;
          }
          scopedEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          for (const scoped of scopedEntries) {
            if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
            const pkgRoot = path.join(scopeRoot, scoped.name);
            if (!isEmberAddonPackage(pkgRoot)) continue;
            const result = tryProbeAddon(pkgRoot, kebabName);
            if (result && isNativeTag(result.tag)) {
              cache.set(cacheKey, result);
              return result;
            }
          }
          continue;
        }
        const pkgRoot = path.join(nodeModules, entry.name);
        if (!isEmberAddonPackage(pkgRoot)) continue;
        const result = tryProbeAddon(pkgRoot, kebabName);
        if (result && isNativeTag(result.tag)) {
          cache.set(cacheKey, result);
          return result;
        }
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}


// Walk a template AST, find every single-segment PascalCase invocation
// (`<EsCard>`, not `<This.Foo>` or `<Forms::TextInput>`), and build a
// `componentTagMap` + `componentAttrMap` keyed by `line:col` (matching
// what the Glint resolver produces). Both maps are returned; callers
// pass them to `blankTemplateContent`.
//
// Skips:
//   - Builtin components (`<Input>`, `<Textarea>`, `<LinkTo>`) — handled
//     by the blanker's builtin map.
//   - Dotted invocations (`<This.Foo>`, `<F.Options>`) — not classic-
//     resolved by name.
//   - Named-block syntax (`<:slot>`).
export function buildClassicComponentTagMap(
  consumerFile: string,
  ast: AST.Template,
): {
  componentTagMap: Map<string, string>;
  componentAttrMap: Map<string, ComponentAttrs>;
} {
  const componentTagMap = new Map<string, string>();
  const componentAttrMap = new Map<string, ComponentAttrs>();
  traverse(ast, {
    ElementNode(node) {
      const tag = node.tag;
      if (!/^[A-Z][A-Za-z0-9]*$/.test(tag)) return;
      if (BUILTIN_COMPONENT_NAMES.has(tag)) return;
      if (!node.loc.start) return;
      const kebab = pascalCaseToKebab(tag);
      const result = findClassicComponent(consumerFile, kebab);
      if (!result) return;
      const key = `${node.loc.start.line}:${node.loc.start.column}`;
      componentTagMap.set(key, result.tag);
      componentAttrMap.set(key, result);
    },
  });
  return { componentTagMap, componentAttrMap };
}

// Test-only: clear the in-memory by-name resolver caches (the
// per-(consumerDir, kebabName) lookup cache and the per-package
// "is an Ember addon" pre-filter cache).
export function _clearClassicResolverCache(): void {
  cache.clear();
  isAddonCache.clear();
}
