import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { preprocess } from '@glimmer/syntax';
import type { AST } from '@glimmer/syntax';

import { blankTemplateContent, blankTemplateContentMultipass, isNativeTag } from '../blank.js';
import type { BlankResult } from '../blank.js';
import type { ComponentAttrs } from '../lib/builtin-components.js';
import { DYNAMIC_VALUE_PLACEHOLDER } from '../lib/dynamic-value.js';
import type * as TS from 'typescript';

import { resolveTemplate } from '../lib/resolver/walk.js';
import { findTemplateSource } from '../lib/resolver/template-source.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'glint-fixtures');

function blank(content: string, scope?: ReadonlyMap<string, string>): BlankResult {
  const result = blankTemplateContent(content, scope);
  expect(result.error).toBeNull();
  return result as BlankResult;
}

describe('length preservation invariant', () => {
  const cases = [
    '<div>hello</div>',
    '<div>{{x}}</div>',
    '<div class="{{x}}">hi</div>',
    '<div class="foo {{x}} bar">hi</div>',
    '<div id={{x}}>hi</div>',
    '<input disabled={{x}} />',
    '<MyButton @arg={{42}} ...attributes>x</MyButton>',
    '<MyComp @label={{t \'Hello\'}}>x</MyComp>',
    '{{!-- comment --}}<div>x</div>',
    '{{#if cond}}<a>x</a>{{else}}<b>y</b>{{/if}}',
    '<div {{on "click" this.handler}}>click</div>',
    '<This.Foo>x</This.Foo>',
    '<:slot>x</:slot>',
    // Classic-Ember (.hbs-flavor) patterns: these go through the same
    // blanker code path as .gts/.gjs but are seen most often in legacy
    // .hbs files. Exercising them in the length-preservation invariant
    // protects the .hbs path against accidental regressions.
    '{{outlet}}',
    '{{#each items as |item|}}<li>{{item}}</li>{{/each}}',
    '{{#each items key="id" as |item index|}}<li>{{item.label}}</li>{{/each}}',
    '{{#let (concat "x-" y) as |z|}}<div id={{z}} />{{/let}}',
    '<p>Prefix {{value}} suffix</p>',
    '<input class="input input--{{size}}" />',
    '{{!-- [html-validate-disable rule] --}}<div>x</div>',
  ];
  it.each(cases)('preserves byte length: %s', (src) => {
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
  });

  it('preserves newlines inside multi-line mustaches', () => {
    const src = '<div>{{t\n  "Long value"\n}}</div>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    // Same number of newlines in input and output.
    expect((out.content.match(/\n/g) ?? []).length).toBe(2);
  });
});

describe('mustache blanking', () => {
  it('blanks {{x}} between text', () => {
    const src = '<div>hi {{x}} bye</div>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).toContain('hi ');
    expect(out.content).toContain(' bye');
    expect(out.content).not.toContain('{{x}}');
  });

  it('blanks {{!-- comment --}}', () => {
    const src = '<div>{{!-- a comment --}}</div>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).not.toContain('comment');
  });

  it('blanks element modifier {{on ...}}', () => {
    const src = '<div {{on "click" this.h}}>x</div>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).not.toContain('{{on');
    expect(out.content).not.toContain('click');
  });

  it('blanks @arg attributes on native elements', () => {
    const src = '<input @arg="x" />';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).not.toContain('@arg');
  });

  it('blanks ...attributes on native elements', () => {
    const src = '<div ...attributes>x</div>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).not.toContain('...attributes');
  });

  it('records `<img ...attributes>` start offset for hook-time src/alt injection', () => {
    // `<img ...attributes>` in a thin wrapper component (parent supplies
    // src AND alt via splat). The blanker erases `...attributes` to
    // whitespace; the transformer's `processElement` hook is responsible
    // for synthesizing src and alt as DynamicValue at parse time. Here
    // we just assert that the offset is recorded so the hook knows
    // which `<img>` to augment.
    //
    // Why hook-time (not source-rewrite): the minimal `...attributes`
    // slot is 13 chars, but no two-attr form html-validate accepts fits
    // (bare `src alt` triggers attribute-allowed-values-missing-value;
    // empty quoted `src=''` triggers attribute-allowed-values-invalid;
    // wide `src='   ' alt='   '` is 19+ chars). Hook-time setAttribute
    // bypasses the slot-width problem.
    const src = '<img ...attributes>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).not.toContain('...attributes');
    expect(injectedAttrsAt(out, 0)).toEqual(new Set(['src', 'alt']));
  });

  it('records the offset even when there are multiple Glimmer-only slots', () => {
    // Real-world `<img>` invocations often have @args / {{on …}} alongside
    // `...attributes`. The hook still needs to know about this img so it
    // can synthesize src/alt — same mechanism regardless of slot count.
    const src = '<img @loading="lazy" {{on "load" this.h}} ...attributes>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(injectedAttrsAt(out, 0)).toEqual(new Set(['src', 'alt']));
  });

  it('does not record offset when the consumer wrote both src and alt explicitly', () => {
    // When src AND alt are both already on the element, no injection is
    // needed — leave the offset out of the registry so the hook skips it.
    const src = '<img src="/foo.png" alt="bar" {{on "load" this.h}} ...attributes>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).toContain('src="/foo.png"');
    expect(out.content).toContain('alt="bar"');
    expect(out.attrInjections!.has(0)).toBe(false);
  });

  it('records offset only for the missing attr when only one is consumer-written', () => {
    // When the consumer wrote only `src=` but not `alt=`, alt still needs
    // synthesis (record `alt`) but src does NOT (already there).
    // Per-attr precision: synthesizing both for any registered offset
    // would silence wcag/h37 (missing alt) when the component only
    // guarantees src.
    const src = '<img src="/foo.png" {{on "load" this.h}} ...attributes>';
    const out = blank(src);
    expect(injectedAttrsAt(out, 0)).toEqual(new Set(['alt']));
  });
});

// Helper: which attrs are registered for hook-injection at this offset.
function injectedAttrsAt(
  out: { attrInjections?: Map<number, Array<{ attr: string; value: string | null }>> },
  offset: number,
): Set<string> {
  return new Set((out.attrInjections?.get(offset) ?? []).map((i) => i.attr));
}

describe('component substitution (transparent fallback)', () => {
  // Without Glint resolution, component invocations have their open and
  // close tags blanked entirely — children float to the actual parent
  // for content-model checks. (Previously substituted to `<x-c>` which
  // FP-fired in strict-content parents like <table> / <ul> / <dl>.)

  it('blanks PascalCase open/close tags; children remain visible', () => {
    const src = '<MyButton>x</MyButton>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).not.toContain('MyButton');
    // Children float through.
    expect(out.content).toContain('x');
    // No <x-c> wrapper anymore.
    expect(out.content).not.toContain('x-c');
  });

  it('blanks self-closing PascalCase entirely', () => {
    const src = '<MyComp />';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).not.toContain('MyComp');
    expect(out.content).not.toContain('x-c');
    // The whole element span is whitespace.
    expect(/^\s+$/.test(out.content)).toBe(true);
  });

  it('blanks dotted components transparently (same as PascalCase)', () => {
    const src = '<This.Foo>some-content</This.Foo>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).not.toContain('This.Foo');
    expect(out.content).not.toContain('x-c');
    // Children pass through.
    expect(out.content).toContain('some-content');
  });

  it('keeps native HTML tags as-is', () => {
    const out = blank('<button>x</button>');
    expect(out.content).toBe('<button>x</button>');
  });

  it('does not leak static-text resolution into component open tag', () => {
    const out = blank('<MyComp @t={{t \'Hello\'}}>body</MyComp>');
    expect(out.content.includes('Hello')).toBe(false);
  });
});

describe('boolean attr handling', () => {
  it('emits presence-only for bare-mustache boolean attr', () => {
    const src = '<input disabled={{x}} />';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).toContain('disabled');
    // No `=` or `{{` after `disabled` — it's a presence-only attribute.
    expect(out.content).not.toContain('disabled=');
    expect(out.content).not.toContain('{{');
  });

  it('emits presence-only for concat-mustache boolean attr', () => {
    const src = '<input checked="x-{{y}}" />';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).toContain('checked');
    expect(out.content).not.toContain('checked=');
  });
});

describe('non-boolean attr DynamicValue path', () => {
  it('emits "<spaces>" for bare-mustache non-boolean attr', () => {
    const out = blank('<div id={{x}}>x</div>');
    // id="   " — quoted with whitespace inside (so processAttribute can yield DynamicValue).
    expect(out.content).toMatch(/id="\s+"/);
  });

  it('emits "<spaces>" for concat-mustache non-boolean attr', () => {
    const out = blank('<div class="prefix-{{x}}">x</div>');
    expect(out.content).toMatch(/class="\s+"/);
    expect(out.content).not.toContain('prefix-');
  });
});

describe('static-text resolution — t-helper', () => {
  it('embeds t-helper key in text content', () => {
    const src = '<h1>{{t \'Hello\'}}</h1>';
    const out = blank(src);
    expect(out.content).toHaveLength(src.length);
    expect(out.content).toMatch(/<h1>Hello\s+<\/h1>/);
  });

  it('embeds t-helper key in attribute value', () => {
    const out = blank('<div aria-label={{t \'Search\'}}>x</div>');
    expect(out.content).toContain('aria-label="Search"');
  });

  it('embeds when text fits inside the mustache span', () => {
    // The literal 'A very long translation key' (27 chars) fits inside the
    // mustache span (32 chars: `{{t 'A very long translation key'}}` minus
    // the `{{t '` and `'}}` overhead — 27 ≤ 32).
    const src = '<h1>{{t \'A very long translation key\'}}</h1>';
    const out = blank(src);
    expect(out.content).toContain('A very long translation key');
  });

  it('skips embedding when mustache spans multiple lines', () => {
    const src = '<h1>{{t\n  \'X\'\n}}</h1>';
    const out = blank(src);
    expect(out.content).not.toContain('X');
    expect(out.content).toHaveLength(src.length);
  });
});

describe('static-text resolution — if-helper', () => {
  it('picks the truthy branch', () => {
    const out = blank('<p>{{if cond \'yes\' \'no\'}}</p>');
    expect(out.content).toContain('yes');
    expect(out.content).not.toContain('no');
  });

  it('falls back to the falsy branch when truthy is non-literal', () => {
    const out = blank('<p>{{if cond this.foo \'fallback\'}}</p>');
    expect(out.content).toContain('fallback');
  });
});

describe('static-text resolution — const lookup', () => {
  const scope = new Map([['MODE', 'auto'], ['LABEL', 'Submit']]);

  it('resolves bare {{NAME}} via scope', () => {
    const out = blank('<div popover={{MODE}}>x</div>', scope);
    expect(out.content).toContain('popover="auto"');
  });

  it('does not resolve unknown names', () => {
    const out = blank('<div popover={{UNKNOWN}}>x</div>', scope);
    expect(out.content).not.toContain('popover="UNKNOWN"');
  });

  it('does not resolve {{name}} when params are present (helper invocation)', () => {
    const out = blank('<div>{{MODE arg}}</div>', scope);
    expect(out.content).not.toContain('auto');
  });
});

describe('if/else single-branch emission', () => {
  it('blanks the inverse branch entirely', () => {
    const src = '{{#if x}}<main>A</main>{{else}}<main>B</main>{{/if}}';
    const out = blank(src);
    expect(out.content).toContain('<main>A</main>');
    expect(out.content).not.toContain('<main>B</main>');
    expect(out.content).toHaveLength(src.length);
  });

  it('blanks {{else if}} chains entirely', () => {
    const src = '{{#if a}}<a>X</a>{{else if b}}<a>Y</a>{{else}}<a>Z</a>{{/if}}';
    const out = blank(src);
    expect(out.content).toContain('<a>X</a>');
    expect(out.content).not.toContain('<a>Y</a>');
    expect(out.content).not.toContain('<a>Z</a>');
  });

  it('handles if without else (no inverse)', () => {
    const src = '{{#if x}}<a>x</a>{{/if}}';
    const out = blank(src);
    expect(out.content).toContain('<a>x</a>');
  });
});

describe('multipass conditional-branch cap (HVE_MAX_CONDITIONAL_BRANCHES)', () => {
  // 6 sibling if/else blocks. The 6th block's inverse contains a
  // sentinel string that's not present anywhere else. With the
  // default cap of 5, the 6th conditional branch isn't enumerated —
  // the single-branch heuristic picks its program for every result,
  // so the sentinel stays blanked. With cap=6, half of the 64
  // combinations select the inverse and expose the sentinel.
  const src =
    '{{#if a}}<div>A1</div>{{else}}<div>A2</div>{{/if}}' +
    '{{#if b}}<div>B1</div>{{else}}<div>B2</div>{{/if}}' +
    '{{#if c}}<div>C1</div>{{else}}<div>C2</div>{{/if}}' +
    '{{#if d}}<div>D1</div>{{else}}<div>D2</div>{{/if}}' +
    '{{#if e}}<div>E1</div>{{else}}<div>E2</div>{{/if}}' +
    '{{#if f}}<div>F1</div>{{else}}<aside>SENTINEL</aside>{{/if}}';

  function withEnv(value: string | undefined, fn: () => void): void {
    const original = process.env['HVE_MAX_CONDITIONAL_BRANCHES'];
    if (value === undefined) delete process.env['HVE_MAX_CONDITIONAL_BRANCHES'];
    else process.env['HVE_MAX_CONDITIONAL_BRANCHES'] = value;
    try {
      fn();
    } finally {
      if (original === undefined) delete process.env['HVE_MAX_CONDITIONAL_BRANCHES'];
      else process.env['HVE_MAX_CONDITIONAL_BRANCHES'] = original;
    }
  }

  function hasSentinel(results: ReturnType<typeof blankTemplateContentMultipass>): boolean {
    // `BlankErrorResult` also has `content` (set to the original
    // input), so `'content' in r` would silently let an error
    // result mask a true negative — the original input contains
    // every sentinel string. Discriminate on `error === null`.
    return results.some((r) => r.error === null && r.content.includes('SENTINEL'));
  }

  it('cap=5 leaves the 6th conditional branch out — error in branch 6 is not surfaced', () => {
    withEnv('5', () => {
      expect(hasSentinel(blankTemplateContentMultipass(src))).toBe(false);
    });
  });

  it('cap=6 includes the 6th conditional branch', () => {
    withEnv('6', () => {
      expect(hasSentinel(blankTemplateContentMultipass(src))).toBe(true);
    });
  });

  it('default cap (≥6) reaches all 6 conditional branches', () => {
    // Default is 10. Sanity check that the unset case enumerates all
    // 6 sibling branches and the 6th-branch sentinel surfaces.
    withEnv(undefined, () => {
      expect(hasSentinel(blankTemplateContentMultipass(src))).toBe(true);
    });
  });

  it('non-numeric value falls back to the default cap', () => {
    // Garbage env value shouldn't crash or yield N=NaN — should
    // behave like "unset" (default cap, all 6 branches enumerated).
    withEnv('not-a-number', () => {
      expect(hasSentinel(blankTemplateContentMultipass(src))).toBe(true);
    });
  });

  it('partial-numeric value falls back to the default cap (no parseInt truncation)', () => {
    // `Number.parseInt('5abc', 10) === 5`, which would silently set
    // cap=5 and hide the 6th branch — surprising for a typo. Strict
    // parsing rejects partial numerics and falls back to default 10,
    // so the sentinel surfaces.
    withEnv('5abc', () => {
      expect(hasSentinel(blankTemplateContentMultipass(src))).toBe(true);
    });
  });

  it('cap=0 disables multipass: single result via the empty-tree path', () => {
    // The documented "disable" contract. Even with 6 conditional
    // branches in the template, cap=0 means none enter the tree —
    // every branch falls to the form-submit-aware single-branch
    // heuristic and we emit one BlankResult.
    withEnv('0', () => {
      const results = blankTemplateContentMultipass(src);
      expect(results).toHaveLength(1);
      expect(results[0]!.error).toBeNull();
    });
  });

  it('all-opaque branches: every combination skipped → single-pass fallback', () => {
    // Both arms of the only conditional branch are opaque-only
    // (whitespace / mustache / comment text). The enumerator yields
    // nothing for either arm, the all-skipped fallback fires, and
    // we get one result from the heuristic-driven single-branch
    // emission. Without the fallback we'd silently lose the
    // template entirely.
    const opaqueSrc = '<div>{{#if x}}  {{else}}  {{/if}}</div>';
    const results = blankTemplateContentMultipass(opaqueSrc);
    expect(results).toHaveLength(1);
    expect(results[0]!.error).toBeNull();
  });

  it('opaque-only nested in program arm: outer.program content still validated', () => {
    // Outer if/else; outer.program contains DOM (`<div>X</div>`)
    // followed by an inner if/else whose arms are both opaque-only
    // (empty Glimmer comments). Tree-aware enumeration must still
    // yield outer.program as a reachable runtime DOM — otherwise
    // <div>X</div> is permanently blanked across all enumerations
    // and html-validate never sees it.
    //
    // Bug it guards against: with a strict tree-aware enumerator,
    // enumerate(outer.programChildren) yields nothing (inner has
    // no enumerable arms), and the outer.program selection gets
    // silently dropped. The fix is to fall through to "emit outer
    // arm with no inner selections" when the inner enumeration is
    // empty — inner branches then fall to the single-branch
    // heuristic.
    const src =
      '{{#if outer}}<div>X</div>{{#if inner}}{{!-- --}}{{else}}{{!-- --}}{{/if}}{{else}}<main>Y</main>{{/if}}';
    const results = blankTemplateContentMultipass(src);
    const blobs = results
      .filter((r): r is BlankResult => r.error === null)
      .map((r) => r.content);
    expect(blobs.some((c) => c.includes('<div>X</div>'))).toBe(true);
    expect(blobs.some((c) => c.includes('<main>Y</main>'))).toBe(true);
  });

  it('opaque-only nested in inverse arm: outer.inverse content still validated', () => {
    // Symmetric to the previous test — outer.inverse is the arm
    // with non-opaque DOM and an opaque-only nested branch. Verifies
    // the fall-through fix is symmetric across program/inverse.
    const src =
      '{{#if outer}}<main>Y</main>{{else}}<div>X</div>{{#if inner}}{{!-- --}}{{else}}{{!-- --}}{{/if}}{{/if}}';
    const results = blankTemplateContentMultipass(src);
    const blobs = results
      .filter((r): r is BlankResult => r.error === null)
      .map((r) => r.content);
    expect(blobs.some((c) => c.includes('<div>X</div>'))).toBe(true);
    expect(blobs.some((c) => c.includes('<main>Y</main>'))).toBe(true);
  });

  it('deeply-nested chain: tree-aware enumeration produces N+1 results, not 2^N', () => {
    // 6 conditional branches nested in a chain — each `{{else}}` is
    // a leaf, each program contains the next branch. Only 7 of the
    // 64 naive combinations correspond to distinct runtime DOMs:
    //   a.inverse → INV_A
    //   a.program, b.inverse → INV_B
    //   ... five more peel-offs ...
    //   a.program ... f.program → PROG_F
    // Pre-tree-aware, the multipass would call the blanker 64 times
    // and rely on the `seen` Set to dedupe down to 7 distinct
    // outputs. Tree-aware skips the redundant calls up front.
    const chain =
      '{{#if a}}' +
        '{{#if b}}' +
          '{{#if c}}' +
            '{{#if d}}' +
              '{{#if e}}' +
                '{{#if f}}<div>PROG_F</div>{{else}}<div>INV_F</div>{{/if}}' +
              '{{else}}<div>INV_E</div>{{/if}}' +
            '{{else}}<div>INV_D</div>{{/if}}' +
          '{{else}}<div>INV_C</div>{{/if}}' +
        '{{else}}<div>INV_B</div>{{/if}}' +
      '{{else}}<div>INV_A</div>{{/if}}';

    withEnv('6', () => {
      const results = blankTemplateContentMultipass(chain);
      expect(results).toHaveLength(7);

      const blobs = results
        .filter((r): r is BlankResult => r.error === null)
        .map((r) => r.content);
      for (const sentinel of ['INV_A', 'INV_B', 'INV_C', 'INV_D', 'INV_E', 'INV_F', 'PROG_F']) {
        expect(blobs.some((c) => c.includes(sentinel))).toBe(true);
      }
    });
  });

  it('cap trims branches in pre-order under tree-aware enumeration', () => {
    // Same 6-deep chain, but cap=3. Only the outer three branches
    // (a, b, c) end up in the tree; d/e/f fall to the single-branch
    // heuristic. Reachable distinct DOMs through the kept tree:
    //   a.inverse → INV_A
    //   a.program, b.inverse → INV_B
    //   a.program, b.program, c.inverse → INV_C
    //   a.program, b.program, c.program → (whatever d/e/f resolve to
    //                                       under the heuristic — one DOM)
    // → 4 distinct results. (Pre-tree-aware would call the blanker
    // 8 times and dedupe to the same 4.)
    const chain =
      '{{#if a}}' +
        '{{#if b}}' +
          '{{#if c}}' +
            '{{#if d}}' +
              '{{#if e}}' +
                '{{#if f}}<div>PROG_F</div>{{else}}<div>INV_F</div>{{/if}}' +
              '{{else}}<div>INV_E</div>{{/if}}' +
            '{{else}}<div>INV_D</div>{{/if}}' +
          '{{else}}<div>INV_C</div>{{/if}}' +
        '{{else}}<div>INV_B</div>{{/if}}' +
      '{{else}}<div>INV_A</div>{{/if}}';

    withEnv('3', () => {
      const results = blankTemplateContentMultipass(chain);
      expect(results).toHaveLength(4);
    });
  });

  it('nested conditionals: tree-aware enumeration covers all reachable runtime DOMs', () => {
    // Outer if/else with an inner if/else inside the program. Naively
    // 2² = 4 combinations, but the two that pick the outer-inverse
    // produce identical blanked text — `inner` lives inside outer's
    // program region, which is blanked when outer-inverse is chosen,
    // so inner's choice is moot. Tree-aware enumeration emits
    // exactly 3 results — one per reachable runtime DOM — without
    // relying on the `seen` dedupe.
    const nested =
      '{{#if outer}}' +
        '{{#if inner}}<div>OUTER_PROGRAM_INNER_PROGRAM</div>' +
        '{{else}}<aside>OUTER_PROGRAM_INNER_INVERSE</aside>{{/if}}' +
      '{{else}}' +
        '<main>OUTER_INVERSE</main>' +
      '{{/if}}';

    const results = blankTemplateContentMultipass(nested);
    expect(results).toHaveLength(3);

    const blobs = results
      .filter((r): r is BlankResult => r.error === null)
      .map((r) => r.content);
    expect(blobs.some((c) => c.includes('OUTER_PROGRAM_INNER_PROGRAM'))).toBe(true);
    expect(blobs.some((c) => c.includes('OUTER_PROGRAM_INNER_INVERSE'))).toBe(true);
    expect(blobs.some((c) => c.includes('OUTER_INVERSE'))).toBe(true);
  });
});

describe('Glint substitution: self-closing component → native tag (FP fix)', () => {
  function blankWithMap(
    src: string,
    componentTagMap: Map<string, string>,
  ): BlankResult {
    const result = blankTemplateContent(src, undefined, undefined, componentTagMap);
    expect(result.error).toBeNull();
    expect(result.content).toHaveLength(src.length);
    return result as BlankResult;
  }

  function locKey(src: string, tagName: string): string {
    const ast = preprocess(src);
    function find(
      node: AST.Template | AST.Statement | AST.TopLevelStatement | undefined | null,
    ): AST.ElementNode | null {
      if (!node) return null;
      if (node.type === 'ElementNode' && node.tag === tagName) return node;
      const kids =
        'body' in node && Array.isArray(node.body)
          ? node.body
          : 'children' in node && Array.isArray(node.children)
          ? node.children
          : [];
      for (const child of kids) {
        const r = find(child);
        if (r) return r;
      }
      return null;
    }
    const elem = find(ast);
    if (!elem) throw new Error(`could not find <${tagName}> in template`);
    return `${elem.loc.start.line}:${elem.loc.start.column}`;
  }

  it('emits <button type="   ">...</button> pair for self-closing component when source has space', () => {
    // Source >= 28 chars (min for `<button type='   '></button>`). Real audit
    // FPs are 100+ char component invocations with @args + class + ...attributes.
    // Three-space type value so processAttribute converts to DynamicValue.
    const src = '<MyButton @label={{a}} @click={{b}} />';
    const map = new Map([[locKey(src, 'MyButton'), 'button']]);
    const r = blankWithMap(src, map);
    expect(r.content).toContain(`<button type='${DYNAMIC_VALUE_PLACEHOLDER}'>`);
    expect(r.content).toContain('</button>');
    expect(r.dynamicContentOffsets).toContain(0);
  });

  it('still substitutes block-form components in place', () => {
    const src = '<MyButton @x={{1}}>click</MyButton>';
    const map = new Map([[locKey(src, 'MyButton'), 'button']]);
    const r = blankWithMap(src, map);
    // Block form: open and close tag renamed (with length-padding);
    // "click" preserved as content.
    expect(r.content).toMatch(/<button\s+/);
    expect(r.content).toContain('click');
    expect(r.content).toMatch(/<\/button\s*>/);
    expect(r.content).not.toContain('x-c');
  });

  it('block-form substitution blanks `as |…|` from the open tag', () => {
    // When Glint resolves a yielding component to a native tag (e.g.
    // `<MyList as |item|>` → div), the in-place open-tag rename leaves
    // `as |item|` in the output, and html-validate's parser then sees
    // `|item|` as an attribute. `attr-case` fires
    // (`Attribute "|item|" should be lowercase`) and downstream rules
    // cascade. The actual rendered DOM has no such attribute — block
    // params are a Glimmer binding for yielded content, not HTML — so
    // the blanker must erase the `as |…|` clause.
    const src = '<MyList @items={{this.xs}} as |item|>x</MyList>';
    const map = new Map([[locKey(src, 'MyList'), 'div']]);
    const r = blankWithMap(src, map);
    expect(
      r.content,
      `block-param syntax must not leak into the blanked open tag; got: ${JSON.stringify(r.content)}`,
    ).not.toMatch(/\|item\|/);
    // Sanity: the substitution itself still happened.
    expect(r.content).toMatch(/<div\s+/);
    expect(r.content).toMatch(/<\/div\s*>/);
  });

  it('block-form substitution blanks multi-param `as |a b|` clauses', () => {
    // After Glimmer normalization block params look like `as |item index|`
    // (space-separated). The blanker's regex `\|[^|]*\|` covers any
    // non-pipe contents, so multi-param forms get blanked uniformly.
    // Typed forms (`as |item: T|`) are stripped earlier by
    // `stripBlockParamTypeAnnotations` before Glimmer's parser sees them,
    // so by the time the AST reaches the blanker the type annotations are
    // gone — no extra coverage needed at this layer.
    const src = '<Each @items={{this.xs}} as |item index|>x</Each>';
    const map = new Map([[locKey(src, 'Each'), 'ul']]);
    const r = blankWithMap(src, map);
    expect(r.content).not.toMatch(/\|item index\|/);
    expect(r.content).toMatch(/<ul\s+/);
  });

  it('block-form: injects multiple literal attrs, longer ones first to avoid starvation', () => {
    // Naive first-fit walking attrs in declaration order would let
    // `a='x'` (5 chars) consume the wide @veryLongFirstAttr slot and
    // leave only the narrow @z slot for `name='longvalue'` (16 chars),
    // silently dropping it. tryInjectComponentAttrs sorts by descending
    // text length so the longer attr claims the wide slot first.
    const src = "<MyButton @veryLongFirstAttr={{val}} @z={{q}}>x</MyButton>";
    const tagMap = new Map([[locKey(src, 'MyButton'), 'button']]);
    const attrMap = new Map<string, ComponentAttrs>([
      [
        locKey(src, 'MyButton'),
        { tag: 'button', attrs: { a: 'x', name: 'longvalue' }, hasSplat: true },
      ],
    ]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap, attrMap);
    expect(r.error).toBeNull();
    expect(r.content).toHaveLength(src.length);
    expect(r.content).toContain("name='longvalue'");
    expect(r.content).toContain("a='x'");
  });

  it("block-form: empty-string literal (boolean shorthand) emits a bare attr name", () => {
    // <button disabled ...attributes> registers `disabled: ''` via
    // literalAttrs. The slot here is wide enough to fit either
    // `disabled='   '` or bare `disabled`; the contract is that the
    // boolean shorthand stays bare so html-validate sees a real
    // boolean attribute, not a 3-space placeholder value.
    const src = "<MyButton @veryLongFirstAttr={{val}}>click</MyButton>";
    const tagMap = new Map([[locKey(src, 'MyButton'), 'button']]);
    const attrMap = new Map<string, ComponentAttrs>([
      [
        locKey(src, 'MyButton'),
        { tag: 'button', attrs: { disabled: '' }, hasSplat: true },
      ],
    ]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap, attrMap);
    expect(r.error).toBeNull();
    expect(r.content).toHaveLength(src.length);
    expect(r.content).toMatch(/<button\s+disabled\s/);
    expect(r.content).not.toContain(`disabled='${DYNAMIC_VALUE_PLACEHOLDER}'`);
    expect(r.content).not.toContain("disabled=");
  });

  it('block-form: boolean attr recorded as DynamicValue placeholder still emits bare', () => {
    // `<button ...attributes disabled={{@x}}>` registers
    // `disabled: '   '` (the DynamicValue placeholder) via literalAttrs.
    // Boolean attrs must always emit presence-only — emitting
    // `disabled='   '` would FP-fire `attribute-boolean-style` even
    // though the consumer's actual runtime value is binary.
    const src = "<MyButton @veryLongFirstAttr={{val}}>click</MyButton>";
    const tagMap = new Map([[locKey(src, 'MyButton'), 'button']]);
    const attrMap = new Map<string, ComponentAttrs>([
      [
        locKey(src, 'MyButton'),
        { tag: 'button', attrs: { disabled: DYNAMIC_VALUE_PLACEHOLDER }, hasSplat: true },
      ],
    ]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap, attrMap);
    expect(r.error).toBeNull();
    expect(r.content).toHaveLength(src.length);
    expect(r.content).toMatch(/<button\s+disabled\s/);
    expect(r.content).not.toContain(`disabled='${DYNAMIC_VALUE_PLACEHOLDER}'`);
    expect(r.content).not.toContain("disabled=");
  });

  it('block-form: aria-* attrs are NOT injected when role is absent (avoids aria-label-misuse FPs)', () => {
    // The chain-attr injection used to land `aria-label='   '` on
    // any substituted element regardless of role context. On plain
    // `<div>` (no role), html-validate's `aria-label-misuse` then
    // FP-fires ("aria-label cannot be used on this element").
    //
    // With anchor-aware injection: aria-* is only emitted when the
    // anchoring `role` is also recorded AND fits in the consumer's
    // Glimmer-attr slots. When role isn't present in the chain, all
    // aria-* attrs are dropped from the substitution. Drift-proof:
    // gates on the `aria-*` PREFIX, not an enumerated list, so new
    // role-dependent aria-* attrs added to html-validate won't slip
    // through.
    const src = "<MyDiv @veryLongFirstAttr={{val}}>x</MyDiv>";
    const tagMap = new Map([[locKey(src, 'MyDiv'), 'div']]);
    const attrMap = new Map<string, ComponentAttrs>([
      [
        locKey(src, 'MyDiv'),
        { tag: 'div', attrs: { 'aria-label': '' }, hasSplat: true },
      ],
    ]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap, attrMap);
    expect(r.error).toBeNull();
    expect(r.content).toHaveLength(src.length);
    expect(r.content).not.toContain('aria-label');
  });

  it('block-form: aria-* attrs ARE injected when role anchors them', () => {
    // When the chain has `role` alongside aria-*, both fit, so the
    // anchored injection is emitted. The substituted output reads
    // `<div role='   ' aria-label='   '>`, which html-validate
    // accepts because the dynamic role authorizes aria-label.
    const src = "<MyDiv @veryLongFirstArg={{val}} @veryLongSecondArg={{val}}>x</MyDiv>";
    const tagMap = new Map([[locKey(src, 'MyDiv'), 'div']]);
    const attrMap = new Map<string, ComponentAttrs>([
      [
        locKey(src, 'MyDiv'),
        {
          tag: 'div',
          attrs: { role: 'dialog', 'aria-label': '' },
          hasSplat: true,
        },
      ],
    ]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap, attrMap);
    expect(r.error).toBeNull();
    expect(r.content).toContain("role='dialog'");
    expect(r.content).toContain(`aria-label='${DYNAMIC_VALUE_PLACEHOLDER}'`);
  });

  it('block-form: builtin attrs apply when Glint resolves the tag without an attrCtx entry', () => {
    // Glint can write a componentTagMap entry for canonical components
    // (e.g. <LinkTo> via @ember/routing types) without a
    // componentAttrMap entry — there's no project .gts file for it to
    // parse for the splatted root. Without a fallback, the .gts/.gjs
    // path skips href injection and aria-label-misuse FP-fires again.
    // We pull the builtin's attrs as long as the resolved tag matches.
    const src = "<LinkTo @route='profile'>X</LinkTo>";
    const tagMap = new Map([[locKey(src, 'LinkTo'), 'a']]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap);
    expect(r.error).toBeNull();
    expect(r.content).toHaveLength(src.length);
    // href placeholder injected from BUILTIN_COMPONENTS even without
    // an attrMap entry from Glint.
    expect(r.content).toMatch(/href\s*=\s*['"]\s+['"]/);
  });

  it('block-form: skips injecting an attr that the invocation already supplies', () => {
    // <SubmitBtn type='button' @longer={{x}}> against a splatted
    // root that records `type='submit'` would otherwise emit two
    // `type` attrs in the substituted <button>. The caller's value
    // wins (matching the common ...attributes-trails-locals pattern).
    const src = "<SubmitBtn type='button' @longer={{xyz}}>click</SubmitBtn>";
    const tagMap = new Map([[locKey(src, 'SubmitBtn'), 'button']]);
    const attrMap = new Map<string, ComponentAttrs>([
      [
        locKey(src, 'SubmitBtn'),
        { tag: 'button', attrs: { type: 'submit' }, hasSplat: true },
      ],
    ]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap, attrMap);
    expect(r.error).toBeNull();
    expect(r.content).toHaveLength(src.length);
    expect(r.content).toContain("type='button'");
    expect(r.content).not.toContain("type='submit'");
  });

  it('falls back to transparent treatment when source is too short to fit <button></button>', () => {
    // 10 chars < 17 (min for `<button></button>`); fall back to
    // transparent neutralize (open/close blanked entirely; children float).
    const src = '<MyComp />';
    const map = new Map([[locKey(src, 'MyComp'), 'button']]);
    const r = blankWithMap(src, map);
    expect(r.content).not.toContain('<button');
    expect(r.content).not.toContain('MyComp');
    expect(r.content).not.toContain('x-c');
  });

  it('handles shorter resolved tags (e.g. div) at modest source lengths', () => {
    const src = '<MyDiv @x={{1}} />';
    const map = new Map([[locKey(src, 'MyDiv'), 'div']]);
    const r = blankWithMap(src, map);
    // 18 chars >= 11 (min for `<div></div>`).
    expect(r.content).toContain('<div>');
    expect(r.content).toContain('</div>');
  });

  it('void native (input): in-place rename, preserves parent attrs, injects type="   "', () => {
    // <LogSlider /> with Element: HTMLInputElement. Substituted in place
    // (no open+close pair — input is void). Parent attrs (id, class, name)
    // stay visible; @args are blanked; `type='   '` is injected into a
    // Glimmer-attr blank area so no-implicit-input-type doesn't FP-fire.
    const src = "<LogSlider @value={{1}} @max={{10}} id='s' class='w-full' />";
    const map = new Map([[locKey(src, 'LogSlider'), 'input']]);
    const r = blankWithMap(src, map);
    // Tag renamed in place.
    expect(r.content).toMatch(/<input\s/);
    // Parent non-Glimmer attrs preserved.
    expect(r.content).toContain("id='s'");
    expect(r.content).toContain("class='w-full'");
    // @value blanked.
    expect(r.content).not.toContain("@value");
    // type='   ' injected (3 spaces — converted to DynamicValue by hook).
    expect(r.content).toContain(`type='${DYNAMIC_VALUE_PLACEHOLDER}'`);
    // No open+close pair (void).
    expect(r.content).not.toContain('</input>');
  });

  it('void native (img): in-place rename without type injection', () => {
    const src = '<MyImg @src={{a}} alt="logo" />';
    const map = new Map([[locKey(src, 'MyImg'), 'img']]);
    const r = blankWithMap(src, map);
    expect(r.content).toMatch(/<img\s/);
    expect(r.content).toContain('alt="logo"');
    expect(r.content).not.toContain('@src');
    // Only input gets type injection — not other voids.
    expect(r.content).not.toContain(`type='${DYNAMIC_VALUE_PLACEHOLDER}'`);
    expect(r.content).not.toContain('</img>');
  });

  it('void native (input): injects literal type from componentAttrMap when Glint provides it', () => {
    // When Glint resolves the component AND extracts the splatted-root's
    // literal `type` attribute, the blanker injects the actual value
    // (e.g. `type='range'`) instead of the 3-space placeholder. Lets
    // html-validate validate the value against the enum.
    const src = "<LogSlider @value={{1}} @max={{10}} id='s' class='w-full' />";
    const tagMap = new Map([[locKey(src, 'LogSlider'), 'input']]);
    const attrMap = new Map([
      [locKey(src, 'LogSlider'), { tag: 'input', attrs: { type: 'range' }, hasSplat: true }],
    ]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap, attrMap);
    expect(r.error).toBeNull();
    expect(r.content).toHaveLength(src.length);
    // Real literal value, not the placeholder.
    expect(r.content).toContain("type='range'");
    expect(r.content).not.toContain(`type='${DYNAMIC_VALUE_PLACEHOLDER}'`);
    // Parent attrs still preserved.
    expect(r.content).toContain("id='s'");
    expect(r.content).toContain("class='w-full'");
  });

  it('void substitution: tryInjectInputType is no-op when no Glimmer-attr area is large enough', () => {
    // Source has no @args / modifiers — nothing to repurpose for type
    // injection. The resolved <input> still substitutes in place; just no
    // type attr injected.
    const src = "<LogSlider id='s' />";
    const map = new Map([[locKey(src, 'LogSlider'), 'input']]);
    const r = blankWithMap(src, map);
    expect(r.content).toMatch(/<input\s/);
    expect(r.content).toContain("id='s'");
    // No type injection since there was no Glimmer-attr area to use.
    expect(r.content).not.toContain(`type='${DYNAMIC_VALUE_PLACEHOLDER}'`);
  });
});

describe('Built-in Ember components (Input / Textarea / LinkTo)', () => {
  // The fallback map kicks in when Glint doesn't resolve a component
  // (the .hbs case primarily; also .gts/.gjs without --glint). Tests
  // here pass NO componentTagMap so the built-in path is the only
  // resolver active.

  function blank(src: string): BlankResult {
    const result = blankTemplateContent(src);
    expect(result.error).toBeNull();
    expect(result.content).toHaveLength(src.length);
    return result as BlankResult;
  }

  it('<Input @value=... /> substitutes to <input> with type=" " injected', () => {
    const src = "<Input @value={{this.name}} id='name' name='name' />";
    const r = blank(src);
    // Tag renamed in place, void path (input is void).
    expect(r.content).toMatch(/<input\s/);
    // type='   ' (3 spaces) injected via tryInjectInputType — converted
    // to DynamicValue by the processAttribute hook.
    expect(r.content).toContain(`type='${DYNAMIC_VALUE_PLACEHOLDER}'`);
    // Parent attrs preserved.
    expect(r.content).toContain("id='name'");
    expect(r.content).toContain("name='name'");
    // No closing tag (input is void).
    expect(r.content).not.toContain('</input>');
  });

  it('<Textarea @value=... /> substitutes to open+close <textarea> pair', () => {
    const src = "<Textarea @value={{this.bio}} id='bio' rows='4' />";
    const r = blank(src);
    // Non-void substitution: open+close pair via substituteSelfClosingComponent.
    expect(r.content).toContain('<textarea');
    expect(r.content).toContain('</textarea>');
    // No type injection for textarea.
    expect(r.content).not.toContain(`type='${DYNAMIC_VALUE_PLACEHOLDER}'`);
  });

  it('<LinkTo>label</LinkTo> block-form substitutes to <a>label</a> in place', () => {
    const src = "<LinkTo @route='x'>View</LinkTo>";
    const r = blank(src);
    // Block-form: tag-name rename; children preserved.
    expect(r.content).toMatch(/<a\s+/);
    expect(r.content).toContain('View');
    expect(r.content).toMatch(/<\/a\s*>/);
    expect(r.content).not.toContain('x-c');
  });

  it('<LinkTo>label</LinkTo> block-form injects href placeholder so <a> is interactive', () => {
    // Without an href, html-validate treats the substituted <a> as a
    // plain placeholder element — the `aria-label-misuse` rule then
    // fires on `<LinkTo aria-label='...'>...</LinkTo>` because aria-label
    // requires an interactive role. At runtime LinkTo always renders an
    // <a> with a computed href, so the substitution should match.
    // Same pattern as the self-closing void path injecting type=' '
    // for <Input> (see lib/builtin-components.ts).
    const src = "<LinkTo @route='profile' aria-label='View profile'>X</LinkTo>";
    const r = blank(src);
    // Either bare `href` or `href='   '` would let html-validate treat
    // the <a> as interactive. The 3-space pattern matches the self-
    // closing path's convention and the href entry in BUILTIN_COMPONENTS.
    expect(r.content).toMatch(/href\s*=\s*['"]\s+['"]/);
  });

  it('Glint resolution takes precedence over built-in mapping when available', () => {
    // If Glint says <Input> resolves to something other than 'input'
    // (unusual but possible if a project shadows the built-in name),
    // the Glint-supplied tag wins.
    const src = "<Input @x={{1}} id='s' />";
    const ast = preprocess(src);
    const elem = ast.body[0];
    if (!elem) throw new Error('expected at least one body element');
    const key = `${elem.loc.start.line}:${elem.loc.start.column}`;
    const tagMap = new Map([[key, 'div']]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap);
    expect(r.error).toBeNull();
    // Substituted to <div>...</div> per Glint, NOT to <input> per built-in.
    expect(r.content).toContain('<div');
    expect(r.content).not.toContain('<input');
  });
});

describe('PascalCase / dotted component child counts as dynamic content', () => {
  // Anchors / buttons / headings whose only child is a non-native
  // component invocation MUST be flagged as having dynamic content,
  // otherwise empty-content rules (`wcag/h30` / `text-content` /
  // `empty-heading`) FP-fire. The component's tags blank to whitespace
  // in our output, but at runtime it may render text; we mark the
  // parent so processElement injects a DynamicValue text node.

  it('flags <a> containing self-closing PascalCase component as dynamic', () => {
    const src = '<a href="/x"><SpanContent @span={{@s}} /></a>';
    const r = blankTemplateContent(src);
    expect(r.error).toBeNull();
    // The anchor's start offset (0) is registered for processElement.
    expect(r.dynamicContentOffsets).toContain(0);
  });

  it('flags <button> containing block-form PascalCase component as dynamic', () => {
    const src = '<button type="button"><Label @text={{@x}}>fallback</Label></button>';
    const r = blankTemplateContent(src);
    expect(r.error).toBeNull();
    expect(r.dynamicContentOffsets).toContain(0);
  });

  it('flags <h1> containing dotted-path component as dynamic', () => {
    const src = '<h1><This.Title /></h1>';
    const r = blankTemplateContent(src);
    expect(r.error).toBeNull();
    expect(r.dynamicContentOffsets).toContain(0);
  });

  it('does NOT flag <button> whose only child is a native (e.g. svg) — icon-only stays detectable', () => {
    const src = '<button type="button"><svg><path d="M0,0" /></svg></button>';
    const r = blankTemplateContent(src);
    expect(r.error).toBeNull();
    expect(r.dynamicContentOffsets).not.toContain(0);
  });
});

describe('Form-submit-in-else (FP fix): single-branch emission prefers branch with submit', () => {
  it('emits the inverse branch when only it has a <button type="submit">', () => {
    const src = `<form>
{{#if x}}<button type='button'>Stop</button>{{else}}<button type='submit'>Send</button>{{/if}}
</form>`;
    const r = blankTemplateContent(src);
    expect(r.error).toBeNull();
    expect(r.content).toHaveLength(src.length);
    // The {{else}} branch (with submit) should be preserved; the if-branch
    // (with type='button' Stop) should be blanked.
    expect(r.content).toContain("type='submit'");
    expect(r.content).toContain('Send');
    expect(r.content).not.toContain('Stop');
  });

  it('emits the program branch when only it has a submit', () => {
    const src = `<form>
{{#if x}}<button type='submit'>A</button>{{else}}<button type='button'>B</button>{{/if}}
</form>`;
    const r = blankTemplateContent(src);
    expect(r.error).toBeNull();
    // Default behavior: program branch wins when it has the submit too.
    expect(r.content).toContain("type='submit'");
    expect(r.content).toContain('A');
    expect(r.content).not.toContain('B');
  });

  it('keeps default (program) when neither branch has a submit', () => {
    const src = `{{#if x}}<main>A</main>{{else}}<main>B</main>{{/if}}`;
    const r = blankTemplateContent(src);
    expect(r.error).toBeNull();
    // Default landmark behavior preserved: only program branch emitted.
    expect(r.content).toContain('A');
    expect(r.content).not.toContain('B');
  });
});

describe('block-form `<button>` substitution registers inputSplatTypeOffsets', () => {
  // Regression for 76901ba: when a curried/hash-yielded component
  // resolves to `<button>` and is invoked block-form, the in-place
  // tag rename produces `<button   ...>` without a `type=` attr.
  // `tryInjectComponentAttrs` doesn't run for such cases because the
  // chain `attrCtx` is undefined for hash-yielded curries — so we
  // register a `type` injection in `attrInjections` and processElement
  // sets it at parse time. Without this, `no-implicit-button-type`
  // FP-fires.
  it('records the offset for block-form <button> substitution when consumer has no `type=`', () => {
    const src = '<RT.Toggle>click</RT.Toggle>';
    const tagMap = new Map([['1:0', 'button']]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    const typeInjections = [...result.attrInjections.values()].flat().filter((i) => i.attr === 'type');
    expect(typeInjections).toHaveLength(1);
    // Value is null (DynamicValue) since no chain attrs were
    // provided — the hook will inject DV at parse time.
    expect(typeInjections[0]!.value).toBeNull();
  });

  it('does NOT register the offset when the consumer wrote type= already', () => {
    const src = '<RT.Toggle type="submit">click</RT.Toggle>';
    const tagMap = new Map([['1:0', 'button']]);
    const r = blankTemplateContent(src, undefined, undefined, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    const typeInjections = [...result.attrInjections.values()].flat().filter((i) => i.attr === 'type');
    expect(typeInjections).toHaveLength(0);
  });
});

describe('curried-yield-hash structural-parent suppression (case C)', () => {
  // Mirrors HDS's `<HdsStepperList as |S|><S.Step>...</S.Step>`
  // pattern: wrapper resolves to a structural-content-restrictive
  // parent (`<ol>`); a dotted curried direct child (`<S.Step>`)
  // resolves to 'transparent' on the consumer side because Glint's
  // hash-yielded curried-component chain doesn't statically tie
  // back to the addon-side source. The static blanker has no way to
  // see that `<S.Step>` renders `<li>` at runtime, so any block-
  // level content INSIDE `<S.Step>` ends up looking like a direct
  // child of the wrapper's `<ol>` and FP-fires
  // `element-permitted-content` ("<div> not permitted under <ol>").
  //
  // Suppression heuristic gated on BOTH conditions: the wrapper
  // resolves to a structural-restrictive parent (per the
  // STRUCTURAL_CONTENT_PARENTS set) AND the wrapper has a
  // transparent dotted direct child. Same per-Source trade-off as
  // case (B).
  it('emits element-permitted-content / -parent in disableForRules when wrapper resolves to <ol> and direct child is dotted+transparent', () => {
    const content = '<W as |S|>\n  <S.Step>\n    <div>step content</div>\n  </S.Step>\n</W>\n';
    const tagMap = new Map<string, string>([
      ['1:0', 'ol'], // <W>
      ['2:2', 'transparent'], // <S.Step>
    ]);
    const r = blankTemplateContent(content, undefined, null, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    expect(result.disableForRules).toContain('element-permitted-content');
    expect(result.disableForRules).toContain('element-permitted-parent');
  });

  it('does NOT suppress when wrapper resolves to a permissive parent (e.g. <div>)', () => {
    const content = '<W as |S|>\n  <S.Step>\n    <span>x</span>\n  </S.Step>\n</W>\n';
    const tagMap = new Map<string, string>([
      ['1:0', 'div'], // permissive — `<div>` accepts <span> directly
      ['2:2', 'transparent'],
    ]);
    const r = blankTemplateContent(content, undefined, null, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    expect(result.disableForRules).not.toContain('element-permitted-content');
    expect(result.disableForRules).not.toContain('element-permitted-parent');
  });

  it('case (B) ALSO suppresses when dotted child resolves to a structural tag (li/option/etc)', () => {
    // Case (B) — pre-existing — already handles this: the dotted
    // child resolves to a CONTENT_RESTRICTED_STRUCTURAL_CHILDREN
    // tag, so the runtime parent might be a different ancestor than
    // the static blanker sees. Documents the overlap with case (C):
    // both fire for this shape; either one alone would suffice.
    const content = '<W as |S|>\n  <S.Step>\n    <div>x</div>\n  </S.Step>\n</W>\n';
    const tagMap = new Map<string, string>([
      ['1:0', 'ol'],
      ['2:2', 'li'],
    ]);
    const r = blankTemplateContent(content, undefined, null, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    expect(result.disableForRules).toContain('element-permitted-content');
    expect(result.disableForRules).toContain('element-permitted-parent');
  });

  it('does NOT suppress when the direct child is non-dotted (suggests wrapper IS runtime parent)', () => {
    const content = '<W>\n  <ChildComponent>\n    <div>x</div>\n  </ChildComponent>\n</W>\n';
    const tagMap = new Map<string, string>([
      ['1:0', 'ol'],
      ['2:2', 'transparent'],
    ]);
    const r = blankTemplateContent(content, undefined, null, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    expect(result.disableForRules).not.toContain('element-permitted-content');
    expect(result.disableForRules).not.toContain('element-permitted-parent');
  });

  // Regression for 9ef0b73 (Copilot round 6): case (B) was over-
  // broad — it suppressed for ANY child resolving to a structural
  // tag, even non-dotted ones. The Copilot reviewer flagged that a
  // non-dotted child like `<HdsListItem>` resolved to `<li>` is the
  // runtime DOM directly under its wrapper, so the wrapper IS the
  // runtime parent and suppressing would mask real
  // `<div><HdsListItem>` violations. The fix narrows case (B) to
  // dotted invocations only (hash-yielded curried components are
  // always dotted on the consumer side).
  it('case (B) does NOT suppress when a non-dotted child resolves to a structural tag (wrapper IS runtime parent)', () => {
    const content =
      '<NonNativeWrapper>\n  <ListItem>\n    <span>x</span>\n  </ListItem>\n</NonNativeWrapper>\n';
    const tagMap = new Map<string, string>([
      // Wrapper is unresolved (no entry); falls into the
      // !isNativeTag && !lookupBuiltinComponent branch where case
      // (B) runs. Pre-fix: child `<ListItem>` resolved to `<li>`
      // would have triggered case (B). Post-fix: only DOTTED
      // children trigger.
      ['2:2', 'li'], // <ListItem> → <li> (concrete, non-dotted)
    ]);
    const r = blankTemplateContent(content, undefined, null, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    expect(result.disableForRules).not.toContain('element-permitted-content');
    expect(result.disableForRules).not.toContain('element-permitted-parent');
  });

  // Ecosystem regression: when the wrapper resolves to a NATIVE tag
  // (e.g. <div> via TS-side type leakage from a wrapped HdsFormField)
  // but contains a transparent dotted curried child whose body has
  // literal `<option>` elements, the runtime DOM has those options
  // in their canonical structural parent (<select>) — not in the
  // wrapper's resolved tag. case-A's recursive descent through
  // transparent dotted children should fire suppression.
  // Ecosystem regression: HDS's `<HdsFormSelectField as |F|>
  // <F.Options><option>` shape where F.Options resolves to <div>
  // (Glint's chain narrowing on TemplateOnlyComponent<Sig> with a
  // wrapping outer element bleeds the wrapper's element type into
  // the curried-yield-hash sub-component's resolution).
  //
  // Descent should fire when the dotted child's resolved tag is NOT
  // a structural-content-parent — in that case we don't trust the
  // resolution to be the runtime parent of the structural literals
  // inside.
  it('case (A) descent: fires when dotted child resolves to a non-structural-parent native (e.g. <div>) but contains literal structural children', () => {
    const content = '<W as |F|>\n  <F.Options>\n    <option>x</option>\n  </F.Options>\n</W>\n';
    const tagMap = new Map<string, string>([
      ['1:0', 'div'],     // <W> resolved to <div>
      ['2:2', 'div'],     // <F.Options> resolved to <div> (Glint chain narrowing)
    ]);
    const r = blankTemplateContent(content, undefined, null, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    expect(
      result.disableForRules,
      `expected suppression when F.Options resolves to non-structural-parent <div> with <option> inside; got: ${JSON.stringify(result.disableForRules)}`,
    ).toContain('element-permitted-content');
  });

  // Counter-test: when the dotted child resolves to a structural-
  // content-parent (e.g. <select>), TRUST the resolution. Structural-
  // literal mismatches there are real bugs (e.g. <th> under <select>)
  // and should fire `element-permitted-content` rather than be
  // suppressed.
  it('case (A) descent: does NOT fire when dotted child resolves to a structural-content-parent (trust Glint resolution)', () => {
    const content = '<W as |C|>\n  <C.Options>\n    <th>real bug</th>\n  </C.Options>\n</W>\n';
    const tagMap = new Map<string, string>([
      ['1:0', 'div'],     // <W>
      ['2:2', 'select'],  // <C.Options> pinned to <select> by Glint
    ]);
    const r = blankTemplateContent(content, undefined, null, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    expect(
      result.disableForRules,
      `must not suppress when dotted child is Glint-resolved to structural parent (real <th>-under-<select> bug); got: ${JSON.stringify(result.disableForRules)}`,
    ).not.toContain('element-permitted-content');
  });

  it('case (A) suppresses when a NATIVE-resolved wrapper has a transparent dotted child containing literal structural elements (multi-level descent)', () => {
    // Wrapper resolves to <div> (NOT a structural-content-parent).
    // Without descent, case-A's wrapper-pinned check would skip
    // (because <div> accepts <option> indirectly via flow content).
    // Without case-C (which only fires on structural-content-parent
    // wrappers), there's no suppression. With the descent, case-A
    // sees `<option>` literals nested inside the transparent dotted
    // child and triggers suppression.
    const content = '<W as |F|>\n  <F.Options>\n    <option>x</option>\n  </F.Options>\n</W>\n';
    const tagMap = new Map<string, string>([
      ['1:0', 'div'], // <W> resolved to <div>
      ['2:2', 'transparent'], // <F.Options> transparent dotted
    ]);
    const r = blankTemplateContent(content, undefined, null, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    expect(
      result.disableForRules,
      `expected suppression on <option> nested inside transparent <F.Options>; got: ${JSON.stringify(result.disableForRules)}`,
    ).toContain('element-permitted-content');
  });

  // Ecosystem regression: HDS's `<HdsForm.Select.Field as |F|>` shape.
  // Surfaced as +120ish FPs across HDS when the canonical-resolver
  // rewrite changed how multi-level yield-hash chains resolve.
  //
  // Shape:
  //   <HdsForm.Select.Field as |F|>
  //     <F.Options>
  //       <option>one</option>
  //       <option>two</option>
  //     </F.Options>
  //   </HdsForm.Select.Field>
  //
  // The dotted chain (`HdsForm.Select.Field`) crosses multiple
  // yield-hash hops on the addon side that the static resolver can't
  // statically follow. F.Options resolves to 'transparent' (we can't
  // statically pin it to <select>). Without case-A descending into
  // unresolvable wrappers' children, the literal `<option>` floats
  // up to whatever native ancestor is at the consumer's call site
  // (often `<div>`) and FP-fires `element-permitted-content`.
  it('case (A) suppresses when an unresolvable dotted wrapper has structural-child literals (multi-level yield-chain)', () => {
    const content = '<HdsForm.Select.Field as |F|>\n  <F.Options>\n    <option>one</option>\n    <option>two</option>\n  </F.Options>\n</HdsForm.Select.Field>\n';
    // F.Options resolves to 'transparent' (unresolvable curried-yield-hash);
    // HdsForm.Select.Field is unresolvable (dotted, no entry in tagMap).
    const tagMap = new Map<string, string>([
      ['2:2', 'transparent'], // <F.Options>
    ]);
    const r = blankTemplateContent(content, undefined, null, tagMap);
    if (r.error) throw r.error;
    const result = r as BlankResult;
    expect(
      result.disableForRules,
      `expected element-permitted-content suppression on <option> under transparent <F.Options> nested in dotted <HdsForm.Select.Field>; got: ${JSON.stringify(result.disableForRules)}`,
    ).toContain('element-permitted-content');
  });

  // Ecosystem regression: `<HdsInteractive>` (Element: HTMLAnchorElement |
  // HTMLButtonElement) wraps content. Glint's TS-side picks one branch
  // arbitrarily; if it picks <button>, then `<HdsBadgeCount>` (which
  // renders <div>) inside fires `element-permitted-content` ("<div>
  // not permitted under <button>"). The canonical resolver walks
  // the template, sees the `{{#if @route}}<LinkTo>{{else if @href}}<a>
  // {{else}}<button>{{/if}}` conditional with differing branches,
  // and returns transparent.
  //
  // The fix: when the canonical resolver returns 'transparent', it
  // overrides the TS-side arbitrary union pick. Pinning to one branch
  // of a polymorphic-on-runtime-condition component cascades FPs.
  it('canonical resolver transparent overrides TS-side arbitrary union pick', () => {
    // Direct test: the resolver returns transparent for a conditional with
    // differing branches; applyResolution then overwrites the TS-side
    // arbitrary first-match pick (e.g. `<a>` from
    // `HTMLAnchorElement | HTMLButtonElement`).
    const ifConditionalTpl = '{{#if @route}}<a href={{@href}}>...</a>{{else}}<button>...</button>{{/if}}';
    const r = resolveTemplate(
      { content: ifConditionalTpl, origin: '/x.gts', kind: 'gts' },
    );
    expect(
      r.kind,
      `conditional with differing branches should resolve transparent; got: ${JSON.stringify(r)}`,
    ).toBe('transparent');
  });

  // Ecosystem regression: HDS's `<HdsInteractive>` (Element:
  // HTMLAnchorElement | HTMLButtonElement) wrapping a `<div>`. Glint's
  // TS-side picks one branch arbitrarily; if it picks `<button>`,
  // children like `<HdsBadgeCount>` (which renders `<div>`) FP-fire
  // `element-permitted-content` ("<div> not permitted under <button>").
  //
  // The canonical resolver walks the conditional template:
  //   {{#if @route}}<LinkTo>{{else if @href}}<a>{{else}}<button>{{/if}}
  // Sees differing branches, returns transparent. applyResolution
  // overrides componentTagMap with 'transparent' so the consumer-side
  // substitution doesn't cascade FPs from the arbitrary pick.
  it('canonical resolver transparent overrides TS-side first-match for polymorphic-condition templates (no FPs in consumer-side substitution)', () => {
    // The fixture mirrors HdsInteractive's shape: a TOC component with
    // a conditional template where each branch renders a different tag.
    // Resolution should return transparent (children float to actual
    // parent), not arbitrarily pick one branch's tag.
    const polyConditional = '{{#if @route}}<a href={{@href}}>{{yield}}</a>{{else}}<button type="button">{{yield}}</button>{{/if}}';
    const r = resolveTemplate({
      content: polyConditional,
      origin: '/x.gts',
      kind: 'gts',
    });
    expect(r.kind).toBe('transparent');
  });

  // Ecosystem regression: HDS's `<HdsCardContainer @tag="li">` shape.
  // Outer template is a `{{#if (eq this.componentTag "div")}}<div>
  // {{else}}<Tag>{{/if}}` polymorphic conditional. With the consumer
  // passing `@tag="li"`, the IF condition evaluates to false at
  // runtime → the runtime DOM is `<li>`. My resolveConditional walks
  // both branches, sees they pin to different tags (`<div>` vs `<li>`),
  // returns transparent. In a `<ul><HdsCardContainer @tag="li">`
  // consumer, transparent cascades FPs (the `<div>` inside floats to
  // `<ul>` because the wrapper blanks transparent).
  //
  // Fix: when an `{{#if}}` condition is `(eq <getter-or-arg> "literal")`
  // AND the consumer's args pin the comparison's value, pick the
  // matching branch instead of bailing to transparent.
  it('canonical resolver: evaluates `(eq @arg "literal")` if-conditions against consumer args to pick a branch', () => {
    const tpl = '{{#if (eq @tag "div")}}<div>{{yield}}</div>{{else}}<li>{{yield}}</li>{{/if}}';
    const r = resolveTemplate(
      { content: tpl, origin: '/x.gts', kind: 'gts' },
      { consumerArgs: new Map([['tag', 'li']]) },
    );
    expect(r.kind).toBe('tag');
    expect((r as { tag: string }).tag).toBe('li');
  });

  it('canonical resolver: bails on `(eq @arg "literal")` when consumer @arg is unknown', () => {
    // Without consumerArgs, the condition is undeterminable — fall back
    // to walking both branches and converging (or transparent).
    const tpl = '{{#if (eq @tag "div")}}<div>{{yield}}</div>{{else}}<li>{{yield}}</li>{{/if}}';
    const r = resolveTemplate({ content: tpl, origin: '/x.gts', kind: 'gts' });
    expect(r.kind).toBe('transparent');
  });

  it('canonical resolver: evaluates `(eq this.componentTag "div")` against consumer args via class-getter walk', () => {
    // HDS's HdsCardContainer pattern: condition uses a class getter
    // (`this.componentTag`) that destructures `{ tag = 'div' } =
    // this.args` and returns it. With consumer @tag="li" the getter
    // resolves to 'li', the IF condition is false → resolves to <li>.
    const filename = path.join(FIXTURES, 'card-container-shape.gts');
    fs.writeFileSync(filename, [
      "import Component from '@glimmer/component';",
      'class CardContainer extends Component<{ Args: { tag?: string }; Blocks: { default: [] }; Element: HTMLElement }> {',
      '  get componentTag(): string {',
      "    const { tag = 'div' } = this.args;",
      '    return tag;',
      '  }',
      '  <template>',
      "    {{#if (eq this.componentTag 'div')}}",
      "      <div ...attributes>{{yield}}</div>",
      '    {{else}}',
      '      {{#let (element this.componentTag) as |Tag|}}',
      '        <Tag ...attributes>{{yield}}</Tag>',
      '      {{/let}}',
      '    {{/if}}',
      '  </template>',
      '}',
      'export default CardContainer;',
    ].join('\n'));
    try {
      const ts = createRequire(import.meta.url)('typescript') as typeof TS;
      const source = findTemplateSource({ declFile: filename, ts });
      expect(source).not.toBeNull();
      const r = resolveTemplate(source!, {
        consumerArgs: new Map([['tag', 'li']]),
        ts,
      });
      expect(r.kind).toBe('tag');
      expect((r as { tag: string }).tag).toBe('li');
    } finally {
      fs.unlinkSync(filename);
    }
  });

  it('canonical resolver: `(eq @arg "literal")` truthy → IF branch', () => {
    // consumer @tag="div": IF condition true → IF branch <div>.
    const tpl = '{{#if (eq @tag "div")}}<div>{{yield}}</div>{{else}}<li>{{yield}}</li>{{/if}}';
    const r = resolveTemplate(
      { content: tpl, origin: '/x.gts', kind: 'gts' },
      { consumerArgs: new Map([['tag', 'div']]) },
    );
    expect(r.kind).toBe('tag');
    expect((r as { tag: string }).tag).toBe('div');
  });

  it('canonical resolver: destructure default = imported enum member resolves to literal', () => {
    // HDS-style: `const DEFAULT_TAG = HdsXxxValues.Div;` where the enum
    // is imported from a sibling `types.ts`. The getter destructures
    // `const { tag = DEFAULT_TAG } = this.args;` and returns `tag`.
    // With no consumer @tag, the default chain must resolve to 'div'.
    const filename = path.join(FIXTURES, 'enum-default-shape.gts');
    const typesFile = path.join(FIXTURES, 'enum-default-types.ts');
    fs.writeFileSync(typesFile, [
      'export enum MyTagValues { Div = "div", Span = "span" }',
      'export type MyTags = `${MyTagValues}`;',
    ].join('\n'));
    fs.writeFileSync(filename, [
      "import Component from '@glimmer/component';",
      "import { MyTagValues } from './enum-default-types.ts';",
      "import type { MyTags } from './enum-default-types.ts';",
      'export const DEFAULT_TAG = MyTagValues.Div;',
      'class EnumDefault extends Component<{ Args: { tag?: MyTags }; Blocks: { default: [] }; Element: HTMLElement }> {',
      '  get componentTag(): MyTags {',
      '    const { tag = DEFAULT_TAG } = this.args;',
      '    return tag;',
      '  }',
      '  <template>',
      '    {{#let (element this.componentTag) as |Tag|}}<Tag ...attributes>{{yield}}</Tag>{{/let}}',
      '  </template>',
      '}',
      'export default EnumDefault;',
    ].join('\n'));
    try {
      const ts = createRequire(import.meta.url)('typescript') as typeof TS;
      const source = findTemplateSource({ declFile: filename, ts });
      expect(source).not.toBeNull();
      const r = resolveTemplate(source!, { ts });
      expect(r.kind).toBe('tag');
      expect((r as { tag: string }).tag).toBe('div');
    } finally {
      fs.unlinkSync(filename);
      fs.unlinkSync(typesFile);
    }
  });

  it('canonical resolver: `return this.args.X ?? EnumName.Member;` (imported enum) resolves to enum literal', () => {
    // HDS dialog-primitive's pattern: getter returns
    // `this.args.titleTag ?? HdsXxxValues.Div;` where the enum is
    // imported from a sibling `types.ts`. The RHS of `??` is a
    // PropertyAccess, not a StringLiteral or Identifier — without the
    // EnumName.Member lookup, the chain breaks and the resolver falls
    // back to the type union's first member (e.g. <h1>).
    const filename = path.join(FIXTURES, 'nullish-enum-default-shape.gts');
    const typesFile = path.join(FIXTURES, 'nullish-enum-default-types.ts');
    fs.writeFileSync(typesFile, [
      'export enum TitleTagValues { Div = "div", H1 = "h1", H2 = "h2" }',
      'export type TitleTags = `${TitleTagValues}`;',
    ].join('\n'));
    fs.writeFileSync(filename, [
      "import Component from '@glimmer/component';",
      "import { TitleTagValues } from './nullish-enum-default-types.ts';",
      "import type { TitleTags } from './nullish-enum-default-types.ts';",
      'class NullishEnumDefault extends Component<{ Args: { titleTag?: TitleTags }; Blocks: { default: [] }; Element: HTMLElement }> {',
      '  get titleTag(): TitleTags {',
      '    return this.args.titleTag ?? TitleTagValues.Div;',
      '  }',
      '  <template>',
      '    {{#let (element this.titleTag) as |Tag|}}<Tag ...attributes>{{yield}}</Tag>{{/let}}',
      '  </template>',
      '}',
      'export default NullishEnumDefault;',
    ].join('\n'));
    try {
      const ts = createRequire(import.meta.url)('typescript') as typeof TS;
      const source = findTemplateSource({ declFile: filename, ts });
      expect(source).not.toBeNull();
      const r = resolveTemplate(source!, { ts });
      expect(r.kind).toBe('tag');
      expect((r as { tag: string }).tag).toBe('div');
    } finally {
      fs.unlinkSync(filename);
      fs.unlinkSync(typesFile);
    }
  });

  it('canonical resolver: `return this.args.X ?? DEFAULT;` (no destructure) resolves via top-level const', () => {
    // HDS dialog-primitive's pattern: getter returns `this.args.X ??
    // DEFAULT` directly. With no consumer @X, fall back to DEFAULT's
    // literal value.
    const filename = path.join(FIXTURES, 'nullish-default-shape.gts');
    fs.writeFileSync(filename, [
      "import Component from '@glimmer/component';",
      "export const DEFAULT_TAG = 'p';",
      'class NullishDefault extends Component<{ Args: { tag?: string }; Blocks: { default: [] }; Element: HTMLElement }> {',
      '  get componentTag(): string {',
      '    return this.args.tag ?? DEFAULT_TAG;',
      '  }',
      '  <template>',
      '    {{#let (element this.componentTag) as |Tag|}}<Tag ...attributes>{{yield}}</Tag>{{/let}}',
      '  </template>',
      '}',
      'export default NullishDefault;',
    ].join('\n'));
    try {
      const ts = createRequire(import.meta.url)('typescript') as typeof TS;
      const source = findTemplateSource({ declFile: filename, ts });
      expect(source).not.toBeNull();
      const r = resolveTemplate(source!, { ts });
      expect(r.kind).toBe('tag');
      expect((r as { tag: string }).tag).toBe('p');
    } finally {
      fs.unlinkSync(filename);
    }
  });
});

describe('isNativeTag', () => {
  it('returns true for HTML tags', () => {
    expect(isNativeTag('button')).toBe(true);
    expect(isNativeTag('div')).toBe(true);
  });

  it('returns true for SVG and MathML tags', () => {
    expect(isNativeTag('svg')).toBe(true);
    expect(isNativeTag('mn')).toBe(true);
  });

  it('returns false for PascalCase / dotted / colon-prefixed', () => {
    expect(isNativeTag('MyButton')).toBe(false);
    expect(isNativeTag('This.Foo')).toBe(false);
    expect(isNativeTag(':slot')).toBe(false);
  });
});
