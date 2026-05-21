// Build the (componentTagMap, componentAttrMap) pair for a Glimmer
// template AST by walking PascalCase invocations and resolving each
// via the canonical resolver. Used by:
//   - .hbs consumers (no Glint, by-name lookup against consumer's deps)
//   - Any path that needs to resolve PascalCase tags in a template AST
//     given just the consumer file path.

import { traverse, type AST } from '@glimmer/syntax';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';

import { BUILTIN_COMPONENTS } from '../builtin-components.js';
import type { ComponentAttrs } from '../builtin-components.js';
import { isComponentTag } from '../../blank.js';
import { findTemplateSource } from './template-source.js';
import { chooseSubstitution, resolveTemplate, isResolvableWrapperTag } from './walk.js';

const BUILTIN_COMPONENT_NAMES: ReadonlySet<string> = new Set(BUILTIN_COMPONENTS.keys());

let cachedTs: typeof TS | null | undefined;
function loadTs(): typeof TS | null {
  if (cachedTs !== undefined) return cachedTs;
  try {
    cachedTs = createRequire(import.meta.url)('typescript') as typeof TS;
  } catch {
    cachedTs = null;
  }
  return cachedTs;
}

export function buildResolutionMaps(
  consumerFile: string,
  ast: AST.Template,
): {
  componentTagMap: Map<string, string>;
  componentAttrMap: Map<string, ComponentAttrs>;
} {
  const componentTagMap = new Map<string, string>();
  const componentAttrMap = new Map<string, ComponentAttrs>();
  const ts = loadTs();

  // Build consumer args once per file.
  const consumerArgsByLoc = new Map<string, Map<string, string>>();
  traverse(ast, {
    ElementNode(node) {
      if (!/^[A-Z]/.test(node.tag)) return;
      if (BUILTIN_COMPONENT_NAMES.has(node.tag)) return;
      if (!node.loc.start) return;
      const args = new Map<string, string>();
      for (const attr of node.attributes ?? []) {
        if (!attr.name.startsWith('@')) continue;
        const argName = attr.name.slice(1);
        if (attr.value.type === 'TextNode') {
          args.set(argName, attr.value.chars);
        }
      }
      if (args.size > 0) {
        const key = `${node.loc.start.line}:${node.loc.start.column}`;
        consumerArgsByLoc.set(key, args);
      }
    },
  });

  traverse(ast, {
    ElementNode(node) {
      const tag = node.tag;
      // Same wrapper-eligibility predicate as walk.ts's resolution paths
      // (covers underscore/namespaced tags), so no-Glint resolution stays
      // consistent with the Glint path.
      if (!isResolvableWrapperTag(tag)) return;
      if (BUILTIN_COMPONENT_NAMES.has(tag)) return;
      if (!node.loc.start) return;
      const source = findTemplateSource({
        consumerFile,
        componentName: tag,
        ts,
      });
      if (!source) return;
      const key = `${node.loc.start.line}:${node.loc.start.column}`;
      const consumerArgs = consumerArgsByLoc.get(key) ?? new Map();
      const resolution = resolveTemplate(source, { consumerArgs, ts });
      if (resolution.kind !== 'tag') return;
      // Apply the SAME yield-ancestor preference the Glint path uses
      // (`applyResolution`): a component whose template is
      // `<nav><ol>{{yield}}</ol></nav>` must substitute as `<ol>` so
      // consumer-yielded `<li>` items validate against `<ol>`, not the
      // outer `<nav>`. Without this the canonical-resolver path
      // FP-fired element-permitted-content/-parent (issue #33).
      const chosen = chooseSubstitution(resolution);
      componentTagMap.set(key, chosen.tag);
      componentAttrMap.set(key, {
        tag: chosen.tag,
        attrs: Object.fromEntries(chosen.attrs),
        hasSplat: chosen.hasSplat,
        fromYieldAncestor: chosen.fromYieldAncestor,
      });
    },
  });

  // Record dotted invocations (`<B.Tr>`, `<F.Legend>`) as 'transparent'.
  // The canonical resolver (walk.ts) returns TRANSPARENT for every dotted
  // tag, and the Glint path (lib/glint.ts:applyResolution) records
  // transparent resolutions as 'transparent'. Mirroring that here lets
  // detectSuppressions' transparent-dotted-child cases fire identically
  // in no-Glint mode — e.g. suppressing element-permitted-content on
  // cells floating under a component-resolved `<table>` (HDS advanced
  // table: `<HdsAdvancedTable as |B|>…<B.Tr><B.Td>…`). Without it the
  // dotted children were absent from the map (not 'transparent'), so the
  // suppression never triggered (~78 HDS `<X> under <table>` FPs).
  // Gate on `isComponentTag` (matches the Glint producer's gate, and
  // covers lowercase-binder dotted like `b.Tr`); never clobber a real-tag
  // entry; don't write componentAttrMap (applyResolution deletes it on
  // transparent).
  traverse(ast, {
    ElementNode(node) {
      const tag = node.tag;
      if (!tag.includes('.')) return;
      if (!isComponentTag(tag)) return;
      if (!node.loc.start) return;
      const key = `${node.loc.start.line}:${node.loc.start.column}`;
      if (!componentTagMap.has(key)) componentTagMap.set(key, 'transparent');
    },
  });

  return { componentTagMap, componentAttrMap };
}
