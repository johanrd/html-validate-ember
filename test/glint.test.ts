// Glint integration tests. Exercise the full pipeline against fixtures
// that approximate a real Ember + Glint project: tsconfig with
// `@glint/ember-tsc/types` augmenting `@glimmer/component`, fixtures that
// use the standard Component<Sig> pattern.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { extractAttrTypeMap } from '../lib/glint.js';

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

  it('resolves a yielded curried sub-component to its declared Element', () => {
    // `<SelectBase as |C|><C.Options><option/></C.Options></SelectBase>`:
    // the parent yields a curried sub-component as a block-param. Glint's
    // `emitComponent(...).element` surfaces as `any` for the curried ref,
    // but the componentRef expression's *type* is `TOC<OptionsSig>`, so
    // `resolveElementFromComponentRefType` reads `Element` off
    // `aliasTypeArguments[0]` directly.
    //
    // Without resolution, `<C.Options>` transparent-blanks and the
    // `<option>` children float to `<SelectBase>`'s `<div>` —
    // `element-permitted-content` then FP-fires.
    const { filename, contents } = readFixture('yielded-curried-component.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const selectEntry = entries.find(([, tag]) => tag === 'select');
    expect(
      selectEntry,
      `expected componentTagMap to resolve <C.Options> to 'select'; got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it('resolves classic Ember addon `.hbs` component root tag (no JS-side Signature)', () => {
    // `fake-card-addon` is a fixture `node_modules` entry whose
    // component template is `addon/templates/components/fake-card.hbs`
    // containing `<li class="fake-card" ...attributes>{{yield}}</li>`.
    // Classic Ember addon shape: no JS-side type info, no Signature,
    // no satisfies-TOC. `resolveAddonHbsTemplate` matches the import
    // path `<addon>/components/<name>` and parses the addon's `.hbs`
    // root element to extract the rendered tag (`li`) plus splatted-
    // root attrs for `componentAttrMap`.
    const { filename, contents } = readFixture('fake-card-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const liEntry = entries.find(([, tag]) => tag === 'li');
    expect(
      liEntry,
      `expected componentTagMap to resolve <FakeCard> to 'li' from its .hbs template; got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it('resolves classic Ember addon `.hbs` for SCOPED package + `templates/components/` import + `app/components/` probed path', () => {
    // Covers three dimensions the previous fixture didn't exercise:
    //   1. `@scope/foo-addon` — the regex must accept scoped packages.
    //   2. Import path uses `templates/components/<name>` (the other
    //      branch of the import regex beyond `components/<name>`).
    //   3. The `.hbs` lives at `app/components/<name>.hbs` (the second
    //      of three probed paths inside the addon, after
    //      `addon/templates/components/<name>.hbs`).
    // Root element is `<section>`, so the consumer's `<main>` parent
    // sees a section as its rendered child.
    const { filename, contents } = readFixture('scoped-card-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const sectionEntry = entries.find(([, tag]) => tag === 'section');
    expect(
      sectionEntry,
      `expected componentTagMap to resolve <ScopedCard> to 'section' from its scoped-package .hbs; got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it('does NOT resolve a classic addon `.hbs` whose root is itself a component (non-native tag)', () => {
    // `composing-addon`'s template is `<AnotherComponent
    // ...attributes>{{yield}}</AnotherComponent>` — the root is a
    // PascalCase component, not a native HTML tag. Without the
    // isNativeTag guard, `AnotherComponent` would land in
    // componentTagMap and blank.ts's substitution path would rename
    // `<ComposedCard>` to `<AnotherComponent>` (a non-native tag
    // emitted into the validated output, breaking content-model
    // checks). The guard rejects non-native tags so the caller falls
    // back to transparent blanking.
    const { filename, contents } = readFixture('composed-card-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const nonNative = entries.find(([, tag]) => tag === 'AnotherComponent');
    expect(
      nonNative,
      `componentTagMap must NOT cache a non-native tag from an addon's .hbs root; got: ${JSON.stringify(entries)}`,
    ).toBeUndefined();
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
