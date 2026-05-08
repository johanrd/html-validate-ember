// Extract attribute info from a component's "splatted root" — the element
// in the component's `<template>` that has `...attributes` (i.e. the
// element that gets the parent invocation's attributes spread onto it; the
// rendered root from the parent's perspective). When the parent substitutes
// <MyComp /> to a native tag (via Glint's Signature['Element'] resolution),
// this attribute info is propagated to the substituted output so
// html-validate sees the runtime-provided attributes as present.
//
// Where this info lands at the consumer call site is controlled by
// `blank.ts`:
//   - Block-form (`<MyComp>...</MyComp>`): `tryInjectComponentAttrs`
//     injects each attr into a Glimmer-only blank slot in the open tag.
//   - Self-closing void native (e.g. component → `<input>`):
//     `substituteSelfClosingVoidComponent` does an in-place tag rename;
//     `tryInjectInputType` injects `type` for `<input>`. Other attrs are
//     not currently embedded.
//   - Self-closing non-void native (e.g. component → `<iframe>`):
//     `substituteSelfClosingComponent` rewrites the whole element span
//     to `<RESOLVED ...attrs></RESOLVED>` and embeds every recorded attr.
//
// Two value forms are recorded:
//   - Literal `TextNode` values are recorded verbatim — html-validate then
//     sees the actual value (e.g. `type='range'` enables enum checks).
//   - Bare-mustache (`title={{@label}}`) and concat-mustache
//     (`class='prefix-{{x}}'`) values are recorded as the
//     `DYNAMIC_VALUE_PLACEHOLDER` constant from `lib/dynamic-value.ts`.
//     The blanker injects this placeholder at the consumer's call
//     site, and `processAttribute` (transform.ts) recognizes it via
//     `isDynamicValuePlaceholder` and converts to a DynamicValue —
//     html-validate sees "attribute present, value unknowable", which
//     is enough for `element-required-attributes` and similar
//     required-attribute rules.
//
// Example: component template
//
//   <template>
//     <input ...attributes type='range' min='0' max='100' value={{@v}} />
//   </template>
//
// `extractSplattedRootFromTemplate` (called by `getSplattedRootsForFile`)
// returns:
//
//   { tag: 'input', attrs: { type: 'range', min: '0', max: '100',
//                            value: DYNAMIC_VALUE_PLACEHOLDER } }
//
// Limitations:
//   - Glimmer-only attrs (`@arg`, `...attributes`, modifiers) are skipped.
//   - When no element has `...attributes`, falls back to the first
//     top-level element (which is the rendered root for most TOC and
//     class-component patterns).
//   - Does not resolve nested `{{#if}}` branches; if the splatted root
//     is conditional, picks the first one it finds.

import { Preprocessor } from 'content-tag';
import { preprocess, traverse } from '@glimmer/syntax';
import type { AST } from '@glimmer/syntax';
import fs from 'node:fs';

import type { ComponentAttrs } from './builtin-components.js';
import { DYNAMIC_VALUE_PLACEHOLDER } from './dynamic-value.js';

const preprocessor = new Preprocessor();

// Per-source-file cache: filename → splatted-root info (or null).
// Process-lifetime: never expires within a process. Fine for the CLI
// (one process per sweep) and for typical IDE re-validation (cache hit
// across rapid edits to the consumer file). A long-running language
// server that wants to pick up edits to the *component* file (the one
// whose splatted root we cached) would need to invalidate on file
// change — `_clearCache` is exposed for tests; a public invalidator
// can be added when that use case lands.
const cache = new Map<string, ComponentAttrs[]>();

function isGlimmerOnlyAttr(name: string | undefined): boolean {
  if (!name) return false;
  return name.startsWith('@') || name === '...attributes' || name === 'as' || name.startsWith('|');
}

function elementHasSplat(node: AST.ElementNode): boolean {
  for (const attr of node.attributes ?? []) {
    if (attr.name === '...attributes') return true;
  }
  return false;
}

function literalAttrs(node: AST.ElementNode): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of node.attributes ?? []) {
    if (isGlimmerOnlyAttr(attr.name)) continue;
    if (attr.value.type === 'TextNode' && typeof attr.value.chars === 'string') {
      attrs[attr.name] = attr.value.chars;
    } else if (
      attr.value.type === 'MustacheStatement' ||
      attr.value.type === 'ConcatStatement'
    ) {
      // Bare-mustache (`title={{@label}}`) and concat-mustache
      // (`class='prefix-{{x}}'`) values are computed at runtime. We can't
      // anticipate the literal, but we DO know the attribute is present —
      // so record it with the shared `DYNAMIC_VALUE_PLACEHOLDER`
      // sentinel. The blanker injects this placeholder into a
      // Glimmer-only blank slot at the consumer's call site, and
      // html-validate's `processAttribute` hook recognizes it via
      // `isDynamicValuePlaceholder` and converts to DynamicValue.
      // This rescues required-attribute rules
      // (e.g. `<iframe title={{@label}}>`-style components surfacing
      // `element-required-attributes` on the wrapped iframe).
      attrs[attr.name] = DYNAMIC_VALUE_PLACEHOLDER;
    }
  }
  return attrs;
}

// Walk a parsed Glimmer template AST and return the splatted-root
// element, or — if no element is splatted — the first top-level element.
// Returns null when the template has no element children at all.
function findSplattedRoot(ast: AST.Template): AST.ElementNode | null {
  let splatted: AST.ElementNode | null = null;
  let firstElement: AST.ElementNode | null = null;
  traverse(ast, {
    ElementNode: {
      enter(node) {
        if (firstElement === null) firstElement = node;
        if (splatted === null && elementHasSplat(node)) {
          splatted = node;
        }
      },
    },
  });
  return splatted ?? firstElement;
}

// Parse a `.gts` file, extract literal attributes from each `<template>`
// block's splatted root, and return a list of `{tag, attrs}` records.
// Most files have one `<template>` (and one component); some files have
// multiple (e.g. multiple TOC consts + a default export). Caller picks
// the relevant entry by index or by template-content matching.
//
// Returns [] on read/parse failure (caller falls back to the placeholder
// path in blank.js).
function parseGtsFile(filename: string): ComponentAttrs[] {
  let contents: string;
  try {
    contents = fs.readFileSync(filename, 'utf8');
  } catch {
    return [];
  }
  let blocks: ReturnType<Preprocessor['parse']>;
  try {
    blocks = preprocessor.parse(contents, { filename });
  } catch {
    return [];
  }
  const out: ComponentAttrs[] = [];
  for (const block of blocks) {
    if (block.tagName !== 'template') continue;
    let ast: AST.Template;
    try {
      ast = preprocess(block.contents);
    } catch {
      continue;
    }
    const root = findSplattedRoot(ast);
    if (!root) continue;
    out.push({
      tag: root.tag,
      attrs: literalAttrs(root),
      hasSplat: elementHasSplat(root),
    });
  }
  return out;
}

// Public entry point: returns an array of splatted-root descriptors for
// every `<template>` block in the given `.gts` file. Cached per filename.
// Caller selects the right entry (typically index 0 for single-template
// files, or by some other heuristic for multi-template files).
export function getSplattedRootsForFile(filename: string): ComponentAttrs[] {
  const cached = cache.get(filename);
  if (cached !== undefined) {
    return cached;
  }
  const result = parseGtsFile(filename);
  cache.set(filename, result);
  return result;
}

// Helper for testing without going through the file system: parse a
// template-content string directly and return its splatted-root descriptor.
export function extractSplattedRootFromTemplate(
  templateContents: string,
): ComponentAttrs | null {
  let ast: AST.Template;
  try {
    ast = preprocess(templateContents);
  } catch {
    return null;
  }
  const root = findSplattedRoot(ast);
  if (!root) return null;
  return {
    tag: root.tag,
    attrs: literalAttrs(root),
    hasSplat: elementHasSplat(root),
  };
}

// Test-only: clear the per-filename cache.
export function _clearCache(): void {
  cache.clear();
}
