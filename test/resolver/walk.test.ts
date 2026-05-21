import { describe, expect, test, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TS from 'typescript';

import { resolveTemplate } from '../../lib/resolver/walk.js';
import {
  findTemplateSource,
  _clearCache,
} from '../../lib/resolver/template-source.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'glint-fixtures');
const ts = createRequire(import.meta.url)('typescript') as typeof TS;

afterEach(() => {
  _clearCache();
});

describe('resolveTemplate', () => {
  describe('native outer', () => {
    test('literal native tag resolves directly', () => {
      const r = resolveTemplate({ content: '<li>{{yield}}</li>', origin: '/x.gts', kind: 'gts' });
      expect(r).toEqual({
        kind: 'tag',
        tag: 'li',
        attrs: new Map(),
        hasSplat: false,
      });
    });

    test('extracts literal attrs from outer', () => {
      const r = resolveTemplate({
        content: '<button type="button" class="btn">{{yield}}</button>',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect(r.kind).toBe('tag');
      expect((r as { tag: string }).tag).toBe('button');
      expect((r as { attrs: Map<string, string> }).attrs.get('type')).toBe('button');
      expect((r as { attrs: Map<string, string> }).attrs.get('class')).toBe('btn');
    });

    test('detects splat attributes', () => {
      const r = resolveTemplate({
        content: '<div ...attributes>{{yield}}</div>',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect((r as { hasSplat: boolean }).hasSplat).toBe(true);
    });

    test('records arg-bound (mustache) attrs as DynamicValue placeholders', () => {
      // `<iframe ...attributes title={{@label}} src={{@src}} />` — required
      // attrs come from typed args. The blanker needs the attr name
      // present (with a placeholder) so element-required-attributes
      // doesn't fire on the substituted iframe.
      const r = resolveTemplate({
        content: '<iframe ...attributes title={{@label}} src={{@src}} />',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect(r.kind).toBe('tag');
      const attrs = (r as { attrs: Map<string, string> }).attrs;
      expect(attrs.has('title')).toBe(true);
      expect(attrs.has('src')).toBe(true);
      // Placeholder is exactly 3 spaces — single source of truth in
      // lib/dynamic-value.ts. We don't bind to that constant here to
      // keep this module independent; the integration test for
      // typed-iframe-consumer end-to-end exercises the predicate.
      expect(attrs.get('title')).toBe('   ');
      expect(attrs.get('src')).toBe('   ');
    });

    test('finds yield-ancestor when different from outer', () => {
      const r = resolveTemplate({
        content: '<div class="wrap"><ul>{{yield}}</ul></div>',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect(r.kind).toBe('tag');
      expect((r as { tag: string }).tag).toBe('div');
      expect((r as { yieldAncestorTag?: string }).yieldAncestorTag).toBe('ul');
    });

    test('no yield-ancestor when {{yield}} is direct child of outer', () => {
      const r = resolveTemplate({
        content: '<button>{{yield}}</button>',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect((r as { yieldAncestorTag?: string }).yieldAncestorTag).toBeUndefined();
    });
  });

  describe('(element X) helper', () => {
    test('literal: (element "li")', () => {
      const r = resolveTemplate({
        content: '{{#let (element "li") as |Tag|}}<Tag ...attributes>{{yield}}</Tag>{{/let}}',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect(r).toMatchObject({ kind: 'tag', tag: 'li', hasSplat: true });
    });

    test('@arg: consumer passes literal', () => {
      const r = resolveTemplate(
        {
          content: '{{#let (element @tag) as |Tag|}}<Tag ...attributes>{{yield}}</Tag>{{/let}}',
          origin: '/x.gts',
          kind: 'gts',
        },
        { consumerArgs: new Map([['tag', 'span']]) },
      );
      expect(r).toMatchObject({ kind: 'tag', tag: 'span' });
    });

    test('@arg: consumer didn\'t pass → transparent', () => {
      const r = resolveTemplate({
        content: '{{#let (element @tag) as |Tag|}}<Tag>{{yield}}</Tag>{{/let}}',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect(r.kind).toBe('transparent');
    });
  });

  describe('conditionals', () => {
    test('both branches resolve to same tag → that tag', () => {
      const r = resolveTemplate({
        content: '{{#if @flag}}<a>{{yield}}</a>{{else}}<a class="alt">{{yield}}</a>{{/if}}',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect((r as { tag: string }).tag).toBe('a');
    });

    test('branches differ → transparent', () => {
      const r = resolveTemplate({
        content: '{{#if @flag}}<a>{{yield}}</a>{{else}}<button>{{yield}}</button>{{/if}}',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect(r.kind).toBe('transparent');
    });
  });

  describe('multi-template + dotted edge cases', () => {
    test('multiple top-level elements → transparent', () => {
      const r = resolveTemplate({
        content: '<div>{{yield}}</div><span>extra</span>',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect(r.kind).toBe('transparent');
    });

    test('dotted-tag outer (e.g., curried child) → transparent', () => {
      const r = resolveTemplate({
        content: '<S.Foo>{{yield}}</S.Foo>',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect(r.kind).toBe('transparent');
    });

    test('passthrough block: {{#each}}<li>...{{/each}} resolves through', () => {
      const r = resolveTemplate({
        content: '{{#each @items as |i|}}<li>{{i}}</li>{{/each}}',
        origin: '/x.gts',
        kind: 'gts',
      });
      expect((r as { tag: string }).tag).toBe('li');
    });
  });

  describe('PascalCase recursion', () => {
    test('cross-package wrapper: PolyListItem → PolyText @tag="li"', () => {
      const declFile = path.join(
        FIXTURES,
        'node_modules/polymorphic-addon-js-only/declarations/components/poly-list-item.d.ts',
      );
      const source = findTemplateSource({ declFile, ts });
      expect(source).not.toBeNull();
      const r = resolveTemplate(source!, { ts });
      // PolyListItem renders <PolyText @tag="li">; PolyText uses (element this.componentTag)
      // which defaults to 'span' but receives @tag="li" through the chain.
      expect((r as { tag: string }).tag).toBe('li');
    });

    test('depth limit prevents infinite recursion', () => {
      // Synthetic: a self-referential template would be cycle-caught
      // before depth limit. We exercise depth via a chain: .gts source
      // that recurses through itself.
      const source = {
        content: '<Self ...attributes>{{yield}}</Self>',
        origin: '/nonexistent/Self.gts',
        kind: 'gts' as const,
      };
      const r = resolveTemplate(source, { ts });
      // Self can't be resolved (no source), so transparent.
      expect(r.kind).toBe('transparent');
    });
  });
});

describe('resolveYieldHashBinding', () => {
  test('hash entry is `(component Inner …)` curried call: resolves through Inner', async () => {
    // HDS HdsFormSectionHeader's pattern:
    //   <template>
    //     <div>{{yield (hash Title=(component HdsFormHeaderTitle size="300"))}}</div>
    //   </template>
    // The hash value is a SubExpression `(component …)`, not a bare
    // PathExpression. Without curried-binding support, `resolveBinding`
    // bails to TRANSPARENT, and Glint's TS-side union pick (the first
    // member of `Element: HTMLSpanElement | HTMLHeadingElement | …`)
    // overrides — landing on `<h1>` and FP-firing
    // element-permitted-content for legal `<div>` content underneath.
    const { resolveYieldHashBinding } = await import('../../lib/resolver/walk.js');
    const innerOrigin = path.join(FIXTURES, 'curry-component-yield-hash-inner.gts');
    const parentContent = `<div ...attributes>{{yield (hash Title=(component CurryInner size="300"))}}</div>`;
    const parentSource = {
      content: parentContent,
      // Origin matters: resolveImport walks the file's imports to
      // find `CurryInner`. Point at the actual fixture parent.
      origin: path.join(FIXTURES, 'curry-component-yield-hash-parent.gts'),
      kind: 'gts' as const,
    };
    const r = resolveYieldHashBinding({
      parentSource,
      hashKey: 'Title',
      parentArgs: new Map(),
      ts,
    });
    expect(r.kind).toBe('tag');
    expect((r as { tag: string }).tag).toBe('div');
  });

  test('VarHead+tail whose head is NOT a block param falls back to resolveByName', async () => {
    // `NavList.Item` is property access on an in-scope const, not a
    // block-param re-yield (`NavList` is never bound via `as |NavList|`).
    // `resolveBlockParamReyield` returns null for the missing binder, so
    // the caller falls back to resolving the head (`NavList`) by name —
    // restoring the pre-re-yield behavior instead of bailing TRANSPARENT.
    const { resolveYieldHashBinding } = await import('../../lib/resolver/walk.js');
    const origin = path.join(FIXTURES, 'dotted-nonblockparam-binding.gts');
    const r = resolveYieldHashBinding({
      parentSource: {
        content: `{{yield (hash Thing=NavList.Item)}}`,
        origin,
        kind: 'gts',
      },
      hashKey: 'Thing',
      parentArgs: new Map(),
      ts,
    });
    expect(r.kind).toBe('tag');
    expect((r as { tag: string }).tag).toBe('nav');
  });

  test('re-yield binder @arg driven by {{this.prop}} resolves via class getter', async () => {
    // `<Binder @elementTag={{this.tag}} as |F|>` — the binder's yielded
    // hash entry depends on `@elementTag`, passed from the re-yielding
    // component's class getter. `binderArgs` must resolve `this.tag` to
    // its literal (`'section'`) — parity with `resolvePascalRecursionWith`
    // — or the binder's `@elementTag` lookup bails TRANSPARENT.
    const { resolveYieldHashBinding } = await import('../../lib/resolver/walk.js');
    const origin = path.join(FIXTURES, 'reyield-binder-thisprop-arg.gts');
    const r = resolveYieldHashBinding({
      parentSource: {
        content: `<Binder @elementTag={{this.tag}} as |F|>{{yield (hash Thing=F.Item)}}</Binder>`,
        origin,
        kind: 'gts',
      },
      hashKey: 'Thing',
      parentArgs: new Map(),
      ts,
    });
    expect(r.kind).toBe('tag');
    expect((r as { tag: string }).tag).toBe('section');
  });

  test('reused block-param name picks the binder enclosing the re-yield, not the first', async () => {
    // Two sibling binders both bind `F`. The `F.Item` re-yield lives in
    // BinderB (→ `<article>`); resolution must scope to that binder, not
    // return the first `F`-binding element BinderA (→ `<section>`).
    const { resolveYieldHashBinding } = await import('../../lib/resolver/walk.js');
    const origin = path.join(FIXTURES, 'reyield-sibling-binder-shadow.gts');
    const r = resolveYieldHashBinding({
      parentSource: {
        content: `<BinderA as |F|>x</BinderA><BinderB as |F|>{{yield (hash Thing=F.Item)}}</BinderB>`,
        origin,
        kind: 'gts',
      },
      hashKey: 'Thing',
      parentArgs: new Map(),
      ts,
    });
    expect(r.kind).toBe('tag');
    expect((r as { tag: string }).tag).toBe('article');
  });

  test('single-template parent: binder resolves via sibling probe, not self-match', async () => {
    // Parent.gts is a single-`<template>` file, so the same-file decl
    // lookup returns the parent itself for any componentName. The binder
    // `<Binder>` (no import) must instead resolve via the sibling
    // `Binder.gts` → `<Sec>` → `<section>`, rather than self-recursing to
    // MAX_DEPTH → TRANSPARENT. Load the parent via `findTemplateSource`
    // (as the real pipeline does) so its content matches the file exactly
    // — the self-match guard compares `{origin, content}`.
    const { resolveYieldHashBinding } = await import('../../lib/resolver/walk.js');
    const origin = path.join(FIXTURES, 'single-template-reyield', 'Parent.gts');
    const parentSource = findTemplateSource({ declFile: origin, ts });
    expect(parentSource).not.toBeNull();
    const r = resolveYieldHashBinding({
      parentSource: parentSource!,
      hashKey: 'Thing',
      parentArgs: new Map(),
      ts,
    });
    expect(r.kind).toBe('tag');
    expect((r as { tag: string }).tag).toBe('section');
  });

  test('binder tag with an underscore resolves (matches the wrapper predicate)', async () => {
    // `<My_Binder>` is a resolvable wrapper everywhere else in the
    // resolver, but the old `/^[A-Z][A-Za-z0-9]*$/` binder regex rejected
    // the underscore, dropping the re-yield chain to TRANSPARENT. With the
    // shared `isResolvableWrapperTag` predicate it resolves → `<aside>`.
    const { resolveYieldHashBinding } = await import('../../lib/resolver/walk.js');
    const origin = path.join(FIXTURES, 'reyield-underscore-binder.gts');
    const r = resolveYieldHashBinding({
      parentSource: {
        content: `<My_Binder as |F|>{{yield (hash Thing=F.Item)}}</My_Binder>`,
        origin,
        kind: 'gts',
      },
      hashKey: 'Thing',
      parentArgs: new Map(),
      ts,
    });
    expect(r.kind).toBe('tag');
    expect((r as { tag: string }).tag).toBe('aside');
  });

  test('same re-yield value under two binders resolves against the matched entry', async () => {
    // `F.Item` appears under BinderA (`Other=F.Item`) and BinderB
    // (`Thing=F.Item`). Resolving `Thing` must bind to BinderB's binder
    // (→ `<article>`), tied to the entry `findYieldHashEntry` returned —
    // not the first `F.Item` occurrence (BinderA → `<section>`).
    const { resolveYieldHashBinding } = await import('../../lib/resolver/walk.js');
    const origin = path.join(FIXTURES, 'reyield-dup-value-binders.gts');
    const r = resolveYieldHashBinding({
      parentSource: {
        content:
          `<BinderA as |F|>{{yield (hash Other=F.Item)}}</BinderA>` +
          `<BinderB as |F|>{{yield (hash Thing=F.Item)}}</BinderB>`,
        origin,
        kind: 'gts',
      },
      hashKey: 'Thing',
      parentArgs: new Map(),
      ts,
    });
    expect(r.kind).toBe('tag');
    expect((r as { tag: string }).tag).toBe('article');
  });

  test('resolveYieldHashBindingSource follows a re-yielded binding (source-level parity)', async () => {
    // `Section=F.Inner` is a re-yield; the source chainer must resolve the
    // binder (`<Binder as |F|>`) and follow its `Inner` to Leaf, instead of
    // treating the name as `F` and returning null. Verifies leaf resolver
    // and source chainer stay in sync for deeper dotted chains.
    const { resolveYieldHashBindingSource, resolveTemplate } = await import('../../lib/resolver/walk.js');
    const origin = path.join(FIXTURES, 'reyield-source-chain.gts');
    const res = resolveYieldHashBindingSource({
      parentSource: {
        content: `<Binder as |F|>{{yield (hash Section=F.Inner)}}</Binder>`,
        origin,
        kind: 'gts',
      },
      hashKey: 'Section',
      ts,
    });
    expect(res).not.toBeNull();
    const r = resolveTemplate(res!.source, { ts });
    expect(r.kind).toBe('tag');
    expect((r as { tag: string }).tag).toBe('article');
  });
});
