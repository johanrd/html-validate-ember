// Glint integration tests. Exercise the full pipeline against fixtures
// that approximate a real Ember + Glint project: tsconfig with
// `@glint/ember-tsc/types` augmenting `@glimmer/component`, fixtures that
// use the standard Component<Sig> pattern.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { extractAttrTypeMap } from '../lib/glint.js';
import { backendFor } from '../lib/backend/index.js';

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

  it('resolves a wrapper to its structural root <li> through a built package with extensionless exports', () => {
    // Regression for the HDS element-permitted-content flood. A
    // published, BUILT package ships compiled `dist/*.js` + `.d.ts`
    // with an extensionless subpath-pattern exports map
    // (`"./*": { "default": "./dist/*" }`) — note no `.js` in the
    // target. `<ListLink>` declares `Element: HTMLAnchorElement` but
    // its compiled template wraps the `<a>` inside `<ListItem>`
    // (→ `<li>`); the structural root is `<li>`.
    //
    // The bug: `resolveModuleSpec` resolves the import via
    // `require.resolve`, which throws for an extensionless exports
    // target (ESM exports don't auto-append `.js`); the catch-fallback
    // only probed `<pkg>/src/`, which a built package doesn't ship.
    // So import resolution returned null, the template-override never
    // ran, and Glint's splatted `Element` tag `<a>` won — FP-firing
    // `element-permitted-content` (`<a>` not permitted under `<ul>`)
    // across HDS (~280 findings). The fix resolves the exports target
    // with extension probing so the wrapper chain (ListLink → ListItem
    // → `<li>`) is walked.
    const { filename, contents } = readFixture('compiled-list-wrapper-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const tags = entries.map(([, t]) => t);
    expect(
      tags.includes('a'),
      `ListLink must resolve to its structural root <li>, not the splatted <a>; got: ${JSON.stringify(entries)}`,
    ).toBe(false);
    expect(
      entries.filter(([, t]) => t === 'li').length,
      `expected both wrappers to resolve to <li>; got: ${JSON.stringify(entries)}`,
    ).toBeGreaterThanOrEqual(2);
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

  it('resolves a RE-YIELDED curried sub-component through the chain (group → fieldset → legend)', () => {
    // HdsFormCheckboxGroup shape: the group renders `<HdsFormFieldset as
    // |F|>` and re-yields `{{yield (hash Legend=F.Legend)}}`, so
    // `<G.Legend>` chains through the nested fieldset's yielded Legend to
    // `<legend>`. Single-level yield-hash (yielded-curried-component.gts)
    // already resolves; this multi-level RE-YIELD did not — `<G.Legend>`
    // fell back to the binder's `<fieldset>` Element type (cross-package)
    // / transparent (local) instead of `<legend>`, so the substituted
    // `<fieldset>` looked legend-less and `wcag/h71` ("fieldset must have
    // a legend as first child") FP-fired ~74× across HDS.
    const { filename, contents } = readFixture('fieldset-group-reyield.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const tags = [...componentTagMap.values()];
    expect(
      tags.includes('legend'),
      `<G.Legend> must resolve to <legend> through the re-yield chain; got: ${JSON.stringify([...componentTagMap.entries()])}`,
    ).toBe(true);
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

  it('descends through pure-yield wrappers (template = `{{yield}}` only) to find the real outer tag', () => {
    // HDS HdsDropdown shape: its template's OUTER element is
    // `<HdsPopoverPrimitive>` — a pure-yielder (just `{{yield (hash …)}}`,
    // no element of its own). The "real" DOM outer is the `<div>` /
    // `<ul>` inside HdsPopoverPrimitive's body. Without pure-yield
    // descent, `<HdsDropdown>` resolves to transparent and the
    // substitution drops its outer wrapper — the inner `<li>` items
    // (D.Interactive) appear as siblings of the consumer's outer
    // `<li>` (SF.Item) and FP-fire `no-implicit-close`.
    const { filename, contents } = readFixture('pure-yield-wrapper-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const ulEntry = entries.find(([, tag]) => tag === 'ul');
    expect(
      ulEntry,
      `expected <Outer> to descend through pure-yield <PureYieldInner> and resolve to <ul> (the real DOM outer); got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it('resolves multi-level dotted invocation `<S.Title>` where `S` itself comes from `<O.Section as |S|>`', () => {
    // HDS form-layout showcase shape:
    //   <HdsForm as |FORM|>
    //     <FORM.Section as |FS|>
    //       <FS.Header as |FSH|>
    //         <FSH.Title>…</FSH.Title>
    // Multi-level dotted binder chain. Without recursive binder
    // lookup, `<FSH.Title>` has binderTag='FS.Header' (dotted) →
    // `findTemplateSource` can't resolve a dotted name → the
    // canonical resolver bails and TS-side picks the first union
    // element-type member ('h1' from HTMLHeadingElement). Real-world
    // FP: <FSH.Title> renders as <div> at runtime but html-validate
    // sees <h1> and FP-fires element-permitted-content on legal
    // `<div>` children underneath.
    const { filename, contents } = readFixture('curry-multi-level-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    // The deepest dotted invocation `<S.Title>` (at template-relative
    // line 6, column 10 in the consumer) must resolve to <div> — not
    // transparent (which would mean we couldn't pin the tag) and
    // not <h1> (Glint TS-side union fallback).
    const sTitle = entries.find(([k]) => k === '6:10');
    expect(
      sTitle?.[1],
      `expected <S.Title> resolution at 6:10 to be 'div' through full 2-level dotted chain; got map: ${JSON.stringify(entries)}`,
    ).toBe('div');
  });

  it('resolves dotted invocation through `(component Inner …)` curried yield-hash', () => {
    // HDS HdsFormSectionHeader yields `Title=(component
    // HdsFormHeaderTitle size="300")` — a curried component
    // reference inside the hash. Without curried-binding support,
    // `<FSH.Title>` resolves to transparent in the canonical resolver,
    // then Glint's TS-side picks the first union element type (often
    // <h1> for HTMLHeadingElement) and FP-fires
    // element-permitted-content on legal `<div>` content underneath.
    //
    // The curry binds `size` but NOT `tag`, so the inner's getter
    // default ('div') should win at the dotted invocation.
    const { filename, contents } = readFixture('curry-component-yield-hash-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const titleEntry = entries.find(([, tag]) => tag === 'div');
    expect(
      titleEntry,
      `expected <P.Title> via curried (component CurryInner size="300") to resolve to 'div' (inner's getter default); got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
    // And critically: must NOT be <h1>, which is what Glint's TS-side
    // union pick produces when the resolver bails to transparent.
    const h1Entry = entries.find(([, tag]) => tag === 'h1');
    expect(
      h1Entry,
      `expected NO <h1> resolution (TS-side union fallback); got: ${JSON.stringify(entries)}`,
    ).toBeUndefined();
  });

  it('passes `@tag={{this.X}}` through wrapper recursion to inner polymorphic component', () => {
    // Mirrors HdsFormHeaderTitle → HdsTextDisplay → HdsText chain:
    // the wrapper's class getter computes the tag value, the wrapper
    // forwards it via `@tag={{this.tag}}` to the inner polymorphic
    // component, and the inner's `(element this.componentTag)` should
    // honour the forwarded literal — not fall back to its own getter
    // default.
    //
    // Before the fix, `resolvePascalRecursion`'s passedArgs builder
    // only handled `@arg={{@caller}}` passthrough, so `{{this.tag}}`
    // dropped on the floor and the inner saw an empty consumerArgs
    // (resolving to <span>, the inner's own default). The whole chain
    // then resolved to <span> and downstream `element-permitted-content`
    // rules FP-fired on legal `<div>`-under-<wrapper>.
    const { filename, contents } = readFixture('this-prop-passthrough-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const divEntry = entries.find(([, tag]) => tag === 'div');
    expect(
      divEntry,
      `expected ThisPropWrapper (no consumer @tag, getter default 'div') to chain through to <div>; got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it('resolves dotted invocations through lowercase block-params (`<Outer as |o|><o.Section>`)', () => {
    // Glimmer permits lowercase block-param dotted invocations:
    //   `<Outer as |o|><o.Section>` parses to ElementNode tag='o.Section'.
    // Ember's convention is PascalCase for block params that point to
    // component hashes, but the parser doesn't enforce that. Regression
    // guard: buildConsumerInfo previously skipped dotted bindings whose
    // first segment was lowercase, leaving the dottedBindings map empty
    // for these consumers and breaking yield-hash resolution. The gate
    // now applies based on `.includes('.')` regardless of casing.
    const { filename, contents } = readFixture('lowercase-block-param-dotted-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    // Mirrors the curry-multi-level test: deepest dotted invocation
    // `<s.Title>` (template-relative line 4 col 6) must reach the
    // inner CurryInner getter's 'div' default.
    const sTitle = entries.find(([k]) => k === '4:6');
    expect(
      sTitle?.[1],
      `expected lowercase-rooted dotted chain to resolve to 'div'; got: ${JSON.stringify(entries)}`,
    ).toBe('div');
  });

  it('propagates `@tag="li"` from the dotted-invocation call site through yield-hash resolution', () => {
    // Regression: previously only the binder's args
    // (`<HdsStepperList @x="y" as |S|>`) flowed into the inner's
    // resolution. Args on the dotted call itself (`<S.Step @tag="li">`)
    // were silently dropped, so the inner polymorphic's getter default
    // won instead of the consumer-provided literal — surface symptom:
    // legal `<li>` content rendered as the getter's default `<div>` and
    // downstream `element-permitted-content` FPs.
    //
    // The curry-component-yield-hash-consumer fixture's parent yields
    // `Title=(component CurryInner size="300")`; CurryInner's getter
    // default is 'div'. With `<P.Title @tag="li">` on the invocation,
    // the merged args (binder + curried + invocation) must produce
    // 'li' (invocation wins against the curry's 'size' which doesn't
    // collide).
    const src = `
import { hash } from '@ember/helper';
import Outer from './curry-component-yield-hash-parent.gts';

<template>
  <Outer as |P|>
    <P.Title @tag="li">title</P.Title>
  </Outer>
</template>
`.trimStart();
    const filename = path.join(fixturesDir, '__inline-tag-prop-dotted.gts');
    fs.writeFileSync(filename, src);
    try {
      const { componentTagMap } = extractAttrTypeMap(filename, src)!;
      const entries = [...componentTagMap.entries()];
      // Look up specifically the `<P.Title @tag="li">` position
      // (template-relative line 3, column 4). The outer `<Outer>` at
      // line 2 also resolves to `<div>` per its own template — that's
      // separate and correct, so we don't blanket-assert on tags.
      const pTitle = entries.find(([k]) => k === '3:4');
      expect(
        pTitle?.[1],
        `expected <P.Title @tag="li"> to resolve to 'li' via merged dotted-invocation args; got map: ${JSON.stringify(entries)}`,
      ).toBe('li');
    } finally {
      fs.unlinkSync(filename);
    }
  });

  it('resolves `{{#let (element this.X) as |Tag|}}` in the component\'s OWN template via class-getter default', () => {
    // Real-world FP source: HdsDialogPrimitiveHeader's own template:
    //   {{#let (element this.titleTag) as |Tag|}}<Tag>…</Tag>{{/let}}
    // with `get titleTag() { return this.args.titleTag ?? DEFAULT_TAG; }`.
    // When extractAttrTypeMap runs against the HDS file ITSELF (i.e.
    // the component is its own consumer), `<Tag>` is a let-block-param
    // declared in the same template — the canonical resolver bails
    // (declFile not top-level), and Glint's TS-side picks the first
    // matching member from the (element …) helper's return-type union
    // (typically <h1> for HTMLHeadingElement when the union includes
    // heading tags). Downstream `element-permitted-content` FP-fires
    // on legal `<div>` content under what html-validate now thinks
    // is an <h1>.
    const { filename, contents } = readFixture('own-template-let-element.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const tags = entries.map(([, tag]) => tag);
    // The class getter returns `args.titleTag ?? 'div'`; with no
    // consumer @titleTag in the own template the default 'div' wins.
    expect(
      tags,
      `expected <Tag> to resolve to 'div' (class-getter default); got map: ${JSON.stringify(entries)}`,
    ).toContain('div');
    expect(
      tags,
      `must NOT fall back to 'h1' (Glint TS-side union pick); got map: ${JSON.stringify(entries)}`,
    ).not.toContain('h1');
  });

  it('conditional outer + yield-hash siblings resolve to DIFFERENT native tags (HDS form-layout shape)', () => {
    // Mirrors HDS's `<HdsForm as |FORM|><FORM.HeaderTitle/><FORM.HeaderDescription/>`
    // shape used in the form-layout containers showcase:
    //   - outer is conditional (`<form>` vs `<div>` per `@tag`) → TRANSPARENT
    //   - yield hash binds two siblings to DIFFERENT native tags:
    //       HeaderTitle       → <div> (class-getter default through
    //                                  polymorphic inner via `@tag={{this.X}}`)
    //       HeaderDescription → <p>   (literal `@tag="p"` through inner)
    //
    // Regression guard: the baseline once captured HeaderTitle as <h1>
    // (Glint TS-side union pick of HTMLHeadingElement when the canonical
    // resolver bailed on the chain) and missed the <p> resolution for
    // HeaderDescription entirely. Both resolutions must now land on
    // their correct native tags simultaneously; surfacing the real
    // `<div>`-under-<p> HTML5 violation when the consumer puts
    // <div>-rooted content inside HeaderDescription is the intended
    // outcome, not an FP.
    const { filename, contents } = readFixture('yield-hash-cond-form-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const tags = entries.map(([, tag]) => tag);
    expect(
      tags,
      `expected <FORM.HeaderTitle> to resolve to 'div'; got map: ${JSON.stringify(entries)}`,
    ).toContain('div');
    expect(
      tags,
      `expected <FORM.HeaderDescription> to resolve to 'p'; got map: ${JSON.stringify(entries)}`,
    ).toContain('p');
    expect(
      tags,
      `must NOT resolve to 'h1' (Glint TS-side union fallback); got map: ${JSON.stringify(entries)}`,
    ).not.toContain('h1');
  });

  it('polymorphic-tag pattern (cross-package): .d.ts → .gts companion + conditional + class-getter resolves to @tag="li"', () => {
    // Cross-package barrel (.d.ts) re-exports a component whose class
    // declaration has no template body. The resolver must bridge to the
    // src/<...>.gts companion (via the package's `exports` map fallback),
    // walk the conditional + class-getter + (element …) helper with
    // consumer @tag="li", and resolve <li>.
    //
    // Pattern: `{{#if (eq this.componentTag "div")}}<div>{{else}}
    // {{#let (element this.componentTag) as |Tag|}}<Tag>{{/let}}{{/if}}`
    // with a getter `const { tag = 'div' } = this.args; return tag;`.
    // HDS card/container is a real-world instance of this pattern.
    const { filename, contents } = readFixture('polymorphic-tag-cross-package-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const liEntry = entries.find(([, tag]) => tag === 'li');
    expect(
      liEntry,
      `expected cross-package PolymorphicCard(@tag="li") to resolve to 'li'; got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });

  it('polymorphic-tag pattern: conditional + `(element this.componentTag)` + class-getter resolves to consumer @tag literal', () => {
    // Polymorphic-tag pattern (e.g. HDS card/container):
    //   {{#if (eq this.componentTag "div")}}
    //     <div>{{yield}}</div>
    //   {{else}}
    //     {{#let (element this.componentTag) as |Tag|}}<Tag>{{yield}}</Tag>{{/let}}
    //   {{/if}}
    // with `get componentTag() { const { tag = 'div' } = this.args; return tag; }`.
    // Consumer passes `@tag="li"` so the IF condition is false → the
    // else branch's `(element this.componentTag)` resolves to 'li'.
    //
    // Regression guard: extractAttrTypeMap must reach the canonical
    // resolver path for this shape (the if-else branch selection in
    // glint.ts), not fall into a fallback that yields 'transparent'.
    const { filename, contents } = readFixture('conditional-element-helper-consumer.gts');
    const { componentTagMap } = extractAttrTypeMap(filename, contents)!;
    const entries = [...componentTagMap.entries()];
    const liEntry = entries.find(([, tag]) => tag === 'li');
    expect(
      liEntry,
      `expected ConditionalElementHelper(@tag="li") to resolve to 'li'; got: ${JSON.stringify(entries)}`,
    ).toBeDefined();
  });
});

describe('type backend selection', () => {
  it('uses the backend named by HVE_TS_BACKEND for the fixture project', () => {
    const { filename } = readFixture('inline-typed-popover.gts');
    expect(backendFor(filename)?.kind).toBe(process.env['HVE_TS_BACKEND'] ?? 'tsgo');
  });
});
