// Glint integration tests. Exercise the full pipeline against fixtures
// that approximate a real Ember + Glint project: tsconfig with
// `@glint/ember-tsc/types` augmenting `@glimmer/component`, fixtures that
// use the standard Component<Sig> pattern.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { extractAttrTypeMap } from '../lib/glint.js';
import { getSplattedRootsForFile, _clearCache as clearComponentAttrsCache } from '../lib/component-attrs.js';
import { isDynamicValuePlaceholder } from '../lib/dynamic-value.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'glint-fixtures');

function readFixture(name: string): { filename: string; contents: string } {
  const filename = path.join(fixturesDir, name);
  const contents = fs.readFileSync(filename, 'utf8');
  return { filename, contents };
}

describe('Glint integration: pipeline', () => {
  it('returns a non-null result when @glint/ember-tsc and a tsconfig are present', () => {
    const { filename, contents } = readFixture('inline-typed-popover.gts');
    const result = extractAttrTypeMap(filename, contents)!;
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('attrTypeMap');
    expect(result).toHaveProperty('componentTagMap');
  });
});

describe('Glint integration: single-file attribute type narrowing', () => {
  it('narrows popover={{@mode}} to its string-literal-union from Signature.Args', () => {
    const { filename, contents } = readFixture('inline-typed-popover.gts');
    const { attrTypeMap } = extractAttrTypeMap(filename, contents)!;
    // @mode: 'auto' | 'manual' | 'hint'
    const entries = [...attrTypeMap.values()];
    const popoverUnion = entries.find(
      (e) =>
        e.kind === 'string-literal-union' &&
        e.values.includes('auto') &&
        e.values.includes('manual') &&
        e.values.includes('hint'),
    );
    expect(popoverUnion).toBeDefined();
  });

  it('reports generic string for aria-label={{@label}} (no narrowing)', () => {
    const { filename, contents } = readFixture('inline-typed-popover.gts');
    const { attrTypeMap } = extractAttrTypeMap(filename, contents)!;
    // @label: string — should come back as kind='other'
    const entries = [...attrTypeMap.values()];
    const stringTypes = entries.filter(
      (e) => e.kind === 'other' && /^string$/.test(e.text ?? ''),
    );
    expect(stringTypes.length).toBeGreaterThan(0);
  });
});

describe('Glint integration: splatted-root literal attribute extraction', () => {
  it('extracts literal type/min/max/step from a sibling .gts component', () => {
    // log-slider.gts has `<input ...attributes type='range' min='0'
    // max='100' step='1' />` as its splatted root. slider-consumer.gts
    // imports it. componentAttrMap should expose those literals so the
    // blanker can inject `type='range'` instead of the 3-space placeholder.
    const { filename, contents } = readFixture('slider-consumer.gts');
    const { componentAttrMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentAttrMap.values()];
    const slider = entries.find((e) => e.tag === 'input' && e.attrs?.type === 'range');
    expect(slider, `expected splatted-root attrs from log-slider.gts; got: ${JSON.stringify(entries)}`).toBeDefined();
    expect(slider!.attrs).toMatchObject({
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
    });
    expect(slider!.hasSplat).toBe(true);
  });

  it('records arg-bound required attributes as DynamicValue placeholders', () => {
    // typed-iframe.gts: `<iframe ...attributes title={{@label}} src={{@src}} />`
    // — required `title` and `src` come from typed args. Without recording
    // them, html-validate's `element-required-attributes` FP-fires on
    // consumers like <TypedFrame @label='...' @src='...' />.
    //
    // literalAttrs records bare-mustache / concat-mustache attrs with
    // the DynamicValue whitespace placeholder so the blanker injects
    // `name='<placeholder>'` and processAttribute converts to
    // DynamicValue. html-validate then sees the attribute as present.
    const filename = path.join(fixturesDir, 'typed-iframe.gts');
    // Use the lower-level extraction directly — we don't need the consumer
    // here, just the splatted-root attrs from the component file itself.
    clearComponentAttrsCache();
    const roots = getSplattedRootsForFile(filename);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.tag).toBe('iframe');
    // Assert via the shared `isDynamicValuePlaceholder` predicate so
    // the test follows any future change to the sentinel
    // (DYNAMIC_VALUE_PLACEHOLDER in lib/dynamic-value.ts) — a 1- or
    // 2-char regression would silently break required-attribute rules,
    // and the predicate is the single source of truth used by
    // `processAttribute`.
    expect(
      isDynamicValuePlaceholder(roots[0]!.attrs.title),
      `title should be a DynamicValue placeholder; got: ${JSON.stringify(roots[0]!.attrs)}`,
    ).toBe(true);
    expect(isDynamicValuePlaceholder(roots[0]!.attrs.src)).toBe(true);
  });

  it('falls back to first element when no element has ...attributes', () => {
    // typed-button.gts: `<button type='button' aria-label={{...}} ...>` —
    // no `...attributes` on the root, but the root is still the rendered
    // element. The extractor falls back to the first element and should
    // expose its literal type='button' attribute.
    const { filename, contents } = readFixture('consumer.gts');
    const { componentAttrMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentAttrMap.values()];
    const button = entries.find((e) => e.tag === 'button' && e.attrs?.type === 'button');
    expect(button).toBeDefined();
    // No `...attributes` in typed-button.gts.
    expect(button!.hasSplat).toBe(false);
  });
});

describe('Glint integration: cross-file .gts type resolution', () => {
  it('resolves <TypedButton /> imported from sibling .gts to "button"', () => {
    // consumer.gts imports TypedButton from './typed-button.gts'.
    // typed-button.gts declares `Signature['Element'] = HTMLButtonElement`.
    // Glint should chase the import via our custom resolveModuleNameLiterals
    // shim, rewrite the imported `.gts` to TS, and surface the Element type
    // back as the resolved tag name 'button'.
    const { filename, contents } = readFixture('consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const buttonEntry = entries.find(([, tag]) => tag === 'button');
    expect(
      buttonEntry,
      `expected componentTagMap to resolve <TypedButton /> to 'button'; got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it('does NOT resolve `Element: HTMLElement` (the generic) to a phantom tag like <abbr>', () => {
    // Surfaced by ecosystem CI on ember-power-select and HDS: a component
    // declaring `Signature['Element'] = HTMLElement` (the bare generic) was
    // resolving to <abbr> because lib.dom.d.ts's HTMLElementTagNameMap has
    // `"abbr": HTMLElement` as its first entry mapping to bare HTMLElement.
    // The inversion picked abbr; downstream rules then FP-fired
    // element-permitted-content on legal content.
    //
    // Correct behaviour: skip the inversion for generic HTMLElement so the
    // component falls through to 'transparent' (children float to real
    // parent), the same outcome as a component with no Element declared.
    const { filename, contents } = readFixture('generic-html-element-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const abbrEntry = entries.find(([, tag]) => tag === 'abbr');
    expect(
      abbrEntry,
      `Element: HTMLElement (generic) must NOT resolve to 'abbr'; got: ${JSON.stringify(entries)}`,
    ).toBeUndefined();
    // And it should resolve as 'transparent' explicitly — null would let
    // blank.ts's built-in name-based fallback fire (e.g. `<Input>` → input
    // even when Glint correctly resolved the user's component).
    const transparentEntry = entries.find(([, tag]) => tag === 'transparent');
    expect(
      transparentEntry,
      `expected componentTagMap to record the component as 'transparent'; got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it('does not crash when the imported .gts does not exist', () => {
    // Negative-path: the shim's path-existence check has to fail gracefully
    // rather than throwing. broken-import.gts imports './does-not-exist.gts'
    // which doesn't exist on disk; extractAttrTypeMap should still return
    // (with the import unresolved) instead of bubbling an error.
    const { filename, contents } = readFixture('broken-import.gts');
    expect(() => extractAttrTypeMap(filename, contents)).not.toThrow();
  });

  it('resolves TOC `satisfies TOC<{Element: HTMLLIElement}>` to "li"', () => {
    // toc-list-item-consumer.gts uses <TocListItem> from a sibling .gts
    // that declares `TOC<{ Element: HTMLLIElement; ... }>` via the
    // satisfies form (`<template>...</template> satisfies TOC<…>`). Glint's
    // emit surfaces `.element` as unknown/any for this shape; the recovery
    // in resolveElementFromTOCDeclaration reads Element from the TOC<…>
    // type-arg directly.
    const { filename, contents } = readFixture('toc-list-item-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const liEntry = entries.find(([, tag]) => tag === 'li');
    expect(
      liEntry,
      `expected componentTagMap to resolve <TocListItem> to 'li'; got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it('resolves TOC `: TOC<{Element: HTMLLIElement}> =` (annotation form) to "li"', () => {
    // toc-annotated-list-item.gts uses the type-annotation form
    // `const X: TOC<{Element: T}> = <template>...</template>;` rather
    // than the satisfies form. Both reach the same emit path and need
    // the same recovery — verifies resolveElementFromTOCDeclaration's
    // type-annotation branch.
    const { filename, contents } = readFixture('toc-annotated-list-item-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const liEntry = entries.find(([, tag]) => tag === 'li');
    expect(
      liEntry,
      `expected componentTagMap to resolve <TocAnnotatedListItem> to 'li'; got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });
});
