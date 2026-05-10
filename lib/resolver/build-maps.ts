// Build the (componentTagMap, componentAttrMap) pair for a Glimmer
// template AST by walking PascalCase invocations and resolving each
// via the canonical resolver. Used by:
//   - .hbs consumers (no Glint, by-name lookup against consumer's deps)
//   - Any path that needs to resolve PascalCase tags in a template AST
//     given just the consumer file path.

import { traverse, type AST } from '@glimmer/syntax';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';

import type { ComponentAttrs } from '../builtin-components.js';
import { findTemplateSource } from './template-source.js';
import { resolveTemplate } from './walk.js';

const BUILTIN_COMPONENT_NAMES: ReadonlySet<string> = new Set([
  'Input',
  'Textarea',
  'LinkTo',
]);

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
      if (!/^[A-Z][A-Za-z0-9]*$/.test(tag)) return;
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
      componentTagMap.set(key, resolution.tag);
      componentAttrMap.set(key, {
        tag: resolution.tag,
        attrs: Object.fromEntries(resolution.attrs),
        hasSplat: resolution.hasSplat,
      });
    },
  });

  return { componentTagMap, componentAttrMap };
}
