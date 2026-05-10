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

describe('Polymorphic-tag chain trace via Glimmer (element ...) helper', () => {
  // HDS-style polymorphic-tag wrappers use the Glimmer `(element X)`
  // helper to render whatever tag `X` resolves to. Glint's TS-side
  // resolution sees the union element type (e.g.
  // `HTMLSpanElement | HTMLHeadingElement | ...`) and arbitrarily
  // picks the first match (`<h1>`), even when the runtime tag is
  // something different (e.g. `<li>` for HDS dropdown list items
  // that pass `@tag="li"`). The chain trace overrides Glint's pick
  // with the literal propagated through `@arg` bindings.

  // (Polymorphic-on-arg unit-level + literal-chain unit-level tests
  // moved to test/resolver/walk.test.ts — they exercised lower-level
  // contracts of the legacy component-attrs.ts.)

  it('resolves polymorphic chain through compiled .js when addon ships v2-spec-standard (no .gts source)', () => {
    // Per the v2-addon spec (and emberjs/rfcs#0931 for the new
    // `template()` API), most addons publish only compiled `.js`
    // + `.d.ts`. The compiled `.js` carries the template inline
    // via `precompileTemplate("CONTENT", ...)` (current shape) or
    // `template("CONTENT", ...)` (RFC-0931 shape). The chain trace
    // should work for these addons too — not just HDS-style addons
    // that ship `.gts` source alongside.
    //
    // Implementation: `extractTemplateContent` uses TS's parser
    // to walk the compiled `.js` AST and extract the first arg of
    // `precompileTemplate(...)`/`template(...)` calls. The class-
    // getter walk for `this.<prop>` resolution (HdsText pattern)
    // also uses TS so the multi-line destructuring shape that
    // compilers emit is handled cleanly (regex parsing was
    // brittle for the compiled-JS form).
    const { filename, contents } = readFixture('cross-package-polymorphic-js-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const tags = [...componentTagMap.values()];
    expect(
      tags,
      `expected PolyListItem to resolve to 'li' via polymorphic chain through compiled .js; got: ${JSON.stringify(tags)}`,
    ).toContain('li');
  });

  it('resolves polymorphic chain through cross-package addon (.d.ts → .gts mapping)', () => {
    // Mirrors the HDS layout: a v2-addon publishes
    // `<pkg>/declarations/X.d.ts` for TS resolution AND
    // `<pkg>/src/X.gts` source. TS resolves the consumer's
    // `import PolyListItem from 'polymorphic-addon/components/poly-list-item'`
    // to the `.d.ts` declFile. Our polymorphic chain uses
    // `resolveGtsPathForPolymorphic` which extends `resolveGtsPath`
    // with `<pkg>/declarations/X.d.ts` → `<pkg>/src/X.gts` so the
    // chain trace can read the addon's template.
    //
    // CRITICAL regression guard: the SAME cross-package shape must
    // NOT cause the leaf-fallback to over-resolve non-polymorphic
    // components. An earlier version had `resolveGtsPath` (used by
    // the leaf-fallback) doing the .d.ts → .gts mapping itself,
    // which surfaced ~397 new `element-permitted-content` FPs on
    // HDS by tagging components via splatted-root scans they
    // weren't designed to support. The narrower
    // `resolveGtsPathForPolymorphic` is gated to the polymorphic
    // chain only.
    const { filename, contents } = readFixture('cross-package-polymorphic-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const tags = [...componentTagMap.values()];
    expect(
      tags,
      `expected PolyListItem to resolve to 'li' via polymorphic chain trace through cross-package .d.ts→.gts; got: ${JSON.stringify(tags)}`,
    ).toContain('li');
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

  it('does NOT resolve `Element: HTMLElement` (the generic) to a phantom tag like <abbr>; falls back to the template root tag', () => {
    // Surfaced by ecosystem CI: a component declaring `Signature['Element']
    // = HTMLElement` (the bare generic) was resolving to <abbr> because
    // lib.dom.d.ts's HTMLElementTagNameMap has `"abbr": HTMLElement` as
    // its first entry mapping to bare HTMLElement. The inversion picked
    // abbr; downstream rules then FP-fired element-permitted-content on
    // legal content.
    //
    // Correct behaviour: skip the inversion for generic HTMLElement.
    // PR #12 originally chose to fall through to 'transparent' so the
    // children floated to the consumer-side parent. We now do better:
    // the component's own `<template>` literally writes `<div>{{yield}}</div>`,
    // so we read the splatted-root (or first-element) tag from the
    // template AST and use that. Resolving to <div> is more accurate
    // than 'transparent' and lets rules that depend on the parent
    // context (`element-permitted-content`, etc.) validate the child
    // against the real wrapper.
    const { filename, contents } = readFixture('generic-html-element-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const abbrEntry = entries.find(([, tag]) => tag === 'abbr');
    expect(
      abbrEntry,
      `Element: HTMLElement (generic) must NOT resolve to 'abbr'; got: ${JSON.stringify(entries)}`,
    ).toBeUndefined();
    // Component's template root is `<div>` — that's what the runtime
    // renders, so the resolution should reflect it.
    const divEntry = entries.find(([, tag]) => tag === 'div');
    expect(
      divEntry,
      `expected componentTagMap to record the component as 'div' (template root); got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it.skip('[REWRITE-TODO] conditional-leaf-href chain-attr collection (internal contract, replaced by transparent + end-to-end FP-prevention)', () => {
    // Mirrors the real-world `<HdsButton>` → `<HdsInteractive>` pattern:
    // an outer wrapper invokes a component whose template is a top-
    // level `{{#if @href}}<a href={{@href}}>{{else}}<button>{{/if}}`.
    // The walker descends through the BlockStatement to find the
    // first reachable native (`<a href={{@href}}>`), and the chain-
    // attr collection unions:
    //   - the outer wrapper level's attrs (`aria-label={{@label}}`)
    //   - the leaf's attrs (`href={{@href}}`)
    // — resulting in `componentAttrMap` recording BOTH. Without this,
    // a consumer-side substitution to `<a aria-label='   '>` (without
    // href) would FP-fire `aria-label-misuse` (anchor without href is
    // non-interactive, can't carry aria-label).
    //
    // (Note: this asserts the AST-level chain-attr collection. The
    // consumer-side source-substitution may still fail to fit `href`
    // into a too-narrow Glimmer-attr slot — that's a separate
    // concern, addressable via a hook-time fallback similar to PR #13's
    // `imgSplatSrcOffsets` / `imgSplatAltOffsets`.)
    const { filename, contents } = readFixture('conditional-leaf-href-consumer.gts');
    const { componentAttrMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentAttrMap.values()];
    const wrapperEntry = entries.find((e) => e.tag === 'a');
    expect(wrapperEntry, `expected <OuterButton> to resolve to 'a' (leaf type)`).toBeDefined();
    expect(
      'href' in wrapperEntry!.attrs,
      `expected chain-attr to include 'href' from the leaf <a> in ConditionalLeaf's template; got: ${JSON.stringify(wrapperEntry!.attrs)}`,
    ).toBe(true);
    expect(
      'aria-label' in wrapperEntry!.attrs,
      `expected chain-attr to include 'aria-label' from OuterButton's wrapping <ConditionalLeaf>; got: ${JSON.stringify(wrapperEntry!.attrs)}`,
    ).toBe(true);
  });

  it('cross-package-barrel-consumer.gts: import-based fallback resolves through barrel re-exports', () => {
    // Mirrors design-system-style component packages: the consumer
    // imports `<ListLink>` through `list-link-addon/components`
    // (a barrel `src/components.ts` re-exporting `default as ListLink`
    // from `./components/list-link.gts`). Glint's TS symbol resolution
    // doesn't always reach the source through such barrels; the
    // import-based fallback in `lib/outer-wrapper-resolver.ts` walks
    // the consumer's `import` statement, resolves the package path
    // (Node-style + `src/<sub>.ts` source preference), follows the
    // re-export, and walks the resulting `<template>` chain.
    //
    // ListLink's leaf is `<a>`; outer wrapper is `<li>` (via
    // `<ListItem>`). The consumer places `<ListLink>` under `<ul>` —
    // legal at runtime (`<ul><li><a></a></li></ul>`). The override
    // resolves to `<li>` and `element-permitted-content` doesn't fire.
    const { filename, contents } = readFixture('cross-package-barrel-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const liEntries = entries.filter(([, tag]) => tag === 'li');
    expect(
      liEntries.length,
      `expected ListLink (imported via barrel) to resolve to 'li'; got: ${JSON.stringify(entries)}`,
    ).toBeGreaterThan(0);
  });

  it('leaf-element-under-list-wrapper-consumer.gts: outer-wrapper resolver overrides leaf-interactive resolution', () => {
    // A component declares `Element: HTMLAnchorElement` (Glint reads
    // the leaf interactive type → 'a'), but its template wraps the
    // `<a>` inside `<ListItem>` (which renders `<li>`):
    //
    //   <template>
    //     <ListItem>
    //       <a ...attributes>{{yield}}</a>
    //     </ListItem>
    //   </template>
    //
    // At runtime the outermost element is `<li>`. The outer-wrapper
    // resolver walks the template chain (ListLink → ListItem → `<li>`)
    // and overrides Glint's leaf-resolved `<a>` with `<li>`. Lets a
    // consumer place this under `<ul>` without `element-permitted-
    // content` FP-firing on `<a>`-under-`<ul>`.
    const { filename, contents } = readFixture('leaf-element-under-list-wrapper-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const liEntries = entries.filter(([, tag]) => tag === 'li');
    expect(
      liEntries.length,
      `expected at least one ListLink invocation to resolve to 'li' (outer wrapper); got: ${JSON.stringify(entries)}`,
    ).toBeGreaterThan(0);
  });

  it('falls back to template-root tag when Glint says transparent and the template literally writes a native wrapper', () => {
    // Mirrors a common pattern: a wrapper component declares
    // `Element: HTMLElement` (bare generic — Glint surfaces this as
    // `'transparent'`) but its `<template>` literally renders
    // `<li ...attributes>{{yield}}</li>`. Without the template-root
    // fallback, our blanker transparent-blanks the wrapper and any
    // `<div>`-rendering child floats to whatever consumer-side
    // ancestor exists (often `<ul>`), then `element-permitted-content`
    // FP-fires.
    //
    // With the fallback, the wrapper resolves to `<li>` (its template
    // root tag), the `<div>` child is correctly nested under `<li>`
    // under `<ul>`, and the rule doesn't fire on legal markup.
    const { filename, contents } = readFixture('transparent-li-wrapper-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const liEntry = entries.find(([, tag]) => tag === 'li');
    expect(
      liEntry,
      `expected the transparent-resolving wrapper to fall back to its template root <li>; got: ${JSON.stringify(entries)}`,
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

  it('curried-via-yield-hash: resolves <S.Step> via parent\'s `{{yield (hash Step=...)}}` when the sub-component has bare HTMLElement', () => {
    // The HDS `<HdsStepperList as |S|><S.Step>` pattern with a curried
    // sub-component whose Signature['Element'] is bare HTMLElement
    // (Glint returns transparent). The canonical resolver follows the
    // parent's `{{yield (hash Step=this.WrappedStep)}}` chain through
    // the class property assignment to the imported component, then
    // walks that component's template to find `<li>`.
    const { filename, contents } = readFixture('yielded-curried-via-template.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const stepEntries = entries.filter(([, tag]) => tag === 'li');
    expect(
      stepEntries.length,
      `expected <S.Step> to resolve to 'li' via yield-hash chain; got: ${JSON.stringify(entries)}`,
    ).toBeGreaterThan(0);
  });
});
