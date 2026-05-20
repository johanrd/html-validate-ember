import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { HtmlValidate } from 'html-validate';
import type { RuleConfig } from 'html-validate';

import plugin from '../index.js';
import { dedupeMultipassReport } from '../lib/multipass-dedupe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ExpectedMessage {
  rule: string;
  line: number;
  column: number;
  message?: string;
  context?: { name?: string } | undefined;
}

interface ValidationResult {
  valid: boolean;
  errorCount: number;
  messages: ExpectedMessage[];
}

function makeValidator(rulesOverride: RuleConfig = {}): HtmlValidate {
  return new HtmlValidate({
    root: true,
    extends: ['html-validate:recommended', 'html-validate-ember:recommended'],
    rules: { 'attribute-allowed-values': 'error', ...rulesOverride },
    plugins: [plugin],
    transform: { '^.*\\.(gts|gjs|hbs)$': 'html-validate-ember' },
  });
}

const fx = (name: string): string => path.join(__dirname, '..', 'examples', name);

async function validate(
  filename: string,
  rulesOverride?: RuleConfig,
): Promise<ValidationResult> {
  const v = makeValidator(rulesOverride);
  const rawReport = await v.validateFile(fx(filename));
  // Multipass branch validation (default) yields one html-validate
  // Source per {{#if}}/{{else}} branch combination; an error stable
  // across branches (e.g., a misnested element outside the if/else) can
  // land in multiple results. Dedupe so tests assert the user-visible
  // count, matching what `validate-gts` prints.
  const report = dedupeMultipassReport(rawReport);
  const messages: ExpectedMessage[] = [];
  for (const r of report.results) {
    for (const m of r.messages) {
      messages.push({
        rule: m.ruleId,
        line: m.line,
        column: m.column,
        message: m.message,
        context: (m as { context?: { name?: string } }).context,
      });
    }
  }
  return { valid: report.valid, errorCount: report.errorCount, messages };
}

// Same as `validate` but skips `dedupeMultipassReport` — mirrors what
// direct html-validate consumers (the VS Code extension, the
// `html-validate` CLI used standalone) see. Used to assert that fixes
// pushed into the Source itself work without the report-side dedupe.
async function validateRaw(
  filename: string,
  rulesOverride?: RuleConfig,
): Promise<ValidationResult> {
  const v = makeValidator(rulesOverride);
  const report = await v.validateFile(fx(filename));
  const messages: ExpectedMessage[] = [];
  for (const r of report.results) {
    for (const m of r.messages) {
      messages.push({
        rule: m.ruleId,
        line: m.line,
        column: m.column,
        message: m.message,
        context: (m as { context?: { name?: string } }).context,
      });
    }
  }
  return { valid: report.valid, errorCount: report.errorCount, messages };
}

describe('end-to-end fixtures', () => {
  it('dir-bad: catches dir="bogus" at exact position', async () => {
    const r = await validate('dir-bad.gts');
    expect(r.errorCount).toBe(1);
    expect(r.messages[0]!.rule).toBe('attribute-allowed-values');
    expect(r.messages[0]!.line).toBe(7);
    expect(r.messages[0]!.column).toBe(13);
  });

  it('comprehensive: only the dir="bogus" violation fires', async () => {
    const r = await validate('comprehensive.gts');
    expect(r.errorCount).toBe(1);
    expect(r.messages[0]!.rule).toBe('attribute-allowed-values');
  });

  it('glimmer-comment-disable: long-form {{!-- ... --}} directive suppresses the rule', async () => {
    const r = await validate('glimmer-comment-disable.gts');
    expect(r.errorCount).toBe(0);
  });

  it('glimmer-comment-disable-short: short-form {{! ... }} directive suppresses the rule', async () => {
    // Confirms the Prettier-collapsed short form parses as an
    // html-validate directive end-to-end (not just at the blanker
    // level). All three dir='bogus' violations should be silenced.
    const r = await validate('glimmer-comment-disable-short.gts');
    expect(r.errorCount).toBe(0);
  });

  it('components: clean (mustaches/components/blocks all handled)', async () => {
    const r = await validate('components.gts');
    expect(r.valid).toBe(true);
  });

  it('static-resolution: t-helper and if-helper resolve so empty-element rules pass', async () => {
    const r = await validate('static-resolution.gts');
    expect(r.valid).toBe(true);
  });

  it('dynamic-attrs: dynamic id pair NOT flagged, static id pair IS flagged', async () => {
    const r = await validate('dynamic-attrs.gts', { 'no-implicit-button-type': 'off', 'void-style': 'off' });
    const dupIds = r.messages.filter((m) => m.rule === 'no-dup-id');
    expect(dupIds).toHaveLength(1);
    // Static id pair starts at line 23, the dynamic pair is on lines 19-20.
    expect(dupIds[0]!.line).toBe(23);
  });

  it('attr-value-resolution: t-helper and if-helper resolve in attribute positions', async () => {
    const r = await validate('attr-value-resolution.gts', { 'no-implicit-button-type': 'off', 'void-style': 'off' });
    // The aria-label-misuse on <div aria-label={{t 'Open menu'}}> is real
    // (div without role can't have aria-label) — the test confirms the
    // helper actually resolved (otherwise the rule wouldn't fire).
    const ariaErrors = r.messages.filter((m) => m.rule === 'aria-label-misuse');
    expect(ariaErrors.length).toBeGreaterThan(0);
  });

  it('const-resolution: top-level consts resolve in attribute positions', async () => {
    const r = await validate('const-resolution.gts', { 'no-implicit-button-type': 'off', 'void-style': 'off' });
    // The fixture has three consts in attribute positions:
    //   <div popover={{POPOVER_MODE}}>   — 'auto' (valid)
    //   <div popover={{BAD_POPOVER}}>    — 'bogus' (invalid)
    //   <form method={{FORM_METHOD}}>    — 'post' (valid)
    // Confirm exactly one attribute-allowed-values error fires (for the
    // bogus value) — proves the consts resolved AND that the valid
    // resolutions don't cause spurious errors.
    const enumErrors = r.messages.filter((m) => m.rule === 'attribute-allowed-values');
    expect(enumErrors).toHaveLength(1);
    expect(enumErrors[0]!.message).toContain('"bogus"');
  });

  it('concat-attr: concat-mustache values resolve to DynamicValue (no false matches on partial literal)', async () => {
    const r = await validate('concat-attr.gts', { 'no-implicit-button-type': 'off', 'void-style': 'off' });
    // No no-dup-id should fire on the concat ids (a-{{x}} vs b-{{x}}).
    const dupIds = r.messages.filter((m) => m.rule === 'no-dup-id');
    expect(dupIds).toHaveLength(0);
  });

  it('component-arg-resolution: static-text doesn\'t leak into substituted component open tags', async () => {
    const r = await validate('component-arg-resolution.gts');
    expect(r.valid).toBe(true);
  });

  it('if-else-landmark: only the truthy branch validates (no duplicate landmark)', async () => {
    const r = await validate('if-else-landmark.gts');
    expect(r.valid).toBe(true);
  });

  it('typed-iframe-consumer: self-closing <TypedFrame /> embeds arg-bound title/src so element-required-attributes does not fire', async () => {
    // End-to-end check for the arg-bound-required-attrs fix. Glint
    // resolves TypedFrame → <iframe>; lib/component-attrs.ts records
    // title/src as DynamicValue placeholders (they're arg-bound in
    // the addon's template); blank.ts's substituteSelfClosingComponent
    // embeds those placeholders in the rewritten <iframe ...></iframe>.
    // Without the embed step, html-validate would FP-fire
    // `element-required-attributes` (`title`) on the substituted iframe.
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validateRaw('typed-iframe-consumer.gts');
      const required = r.messages.filter((m) => m.rule === 'element-required-attributes');
      expect(
        required,
        `element-required-attributes must not fire on substituted <iframe>; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('img-splat-thin-wrapper: `<img ...attributes>` does not FP-fire wcag/h37 or element-required-attributes', async () => {
    // Thin <img> wrapper component — parent provides src + alt via the
    // splat. The `...attributes` slot is 13 chars, too narrow to source-
    // rewrite both 9-char `attr='   '` placeholders. Hook-time setAttribute
    // synthesizes src + alt as DynamicValue at parse time so wcag/h37
    // (missing alt) and element-required-attributes (missing src) don't
    // fire on what the consumer actually fills in. Mirrors super-rentals'
    // `rental/image.gjs`.
    const r = await validate('img-splat-thin-wrapper.gjs', { 'void-style': 'off' });
    const offenders = r.messages.filter(
      (m) => m.rule === 'wcag/h37' || m.rule === 'element-required-attributes',
    );
    expect(
      offenders,
      `wcag/h37 / element-required-attributes must not fire on <img ...attributes>; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('anchor-target-href-consumer: substituted <a> with target/rel from chain does not FP-fire attribute-misuse when href could not fit a narrow Glimmer-attr slot', async () => {
    // Mirrors `<HdsLinkInline @href='#' @color='primary'>` external-link
    // branch: addon template `<a target='_blank' rel='noopener noreferrer'
    // ...attributes href={{@href}}>{{yield}}</a>`. Chain-attr collection
    // records target+rel+href; consumer-side narrow slots fit target
    // (16 chars in `@color='primary'`) but not href (10 chars in
    // `@href='#'` = 9 chars). Hook-time setAttribute('href',
    // DynamicValue) compensates so `attribute-misuse` ("target requires
    // href") doesn't fire.
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validate('anchor-target-href-consumer.gts');
      const offenders = r.messages.filter((m) => m.rule === 'attribute-misuse');
      expect(
        offenders,
        `attribute-misuse must not fire on substituted <a> after hook-time href injection; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('input-type-no-glimmer-slot-consumer: void <input> substitution with NO Glimmer-attr slots still gets `type` from the chain', async () => {
    // Mirrors HDS `<HdsFormCheckboxBase aria-label="…" />`: addon
    // template has `<input type="checkbox" ...attributes />` (literal
    // type), but the consumer writes only non-Glimmer attrs. Source-
    // side `tryInjectInputType` has no `@arg=`/modifier candidate
    // range, so the substituted `<input>` reaches html-validate
    // type-less and FP-fires `no-implicit-input-type`. The fix:
    // hook-time setAttribute('type', literal) when source-side
    // injection bails and the chain has a literal type.
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validate('input-type-no-glimmer-slot-consumer.gts', { 'void-style': 'off' });
      const offenders = r.messages.filter((m) => m.rule === 'no-implicit-input-type');
      expect(
        offenders,
        `no-implicit-input-type must not fire on substituted <input> when chain has literal type; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('multi-yield-table-consumer: wrapper with multi-yield template (different ancestors per named block) substitutes to outer wrapper, not first yield-ancestor', async () => {
    // Mirrors HDS `<HdsTable>` shape — its template yields to BOTH
    // `to="head"` (inside `<thead>`) and `to="body"` (inside
    // `<tbody>`). The outer-wrapper-resolver's yield-nearest-
    // ancestor walk picks the first yield it sees, surfacing
    // `<thead>` as the yield-ancestor. Dual-tag substitution then
    // prefers `<thead>` over the actual outer wrapper `<table>`,
    // and a consumer like `<div><MultiYieldTable /></div>` becomes
    // `<div><thead></div>` after blanking — FP-firing
    // `element-permitted-content` ("<thead> not permitted under
    // <div>"). Real DOM is `<div><table>...</table></div>`, valid.
    //
    // Fix: when a template has yields in multiple distinct native
    // ancestors, return null (no single yield-ancestor) so dual-tag
    // falls back to the outer wrapper. Loses the named-block-
    // specific child-validation power, but eliminates the wrong-
    // ancestor FP class.
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validate('multi-yield-table-consumer.gts');
      const offenders = r.messages.filter(
        (m) => m.rule === 'element-permitted-content' || m.rule === 'element-permitted-parent',
      );
      expect(
        offenders,
        `element-permitted-content / -parent must not fire when wrapper has multi-yield template; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('issue #33: component resolving to <nav><ol>{{yield}}</ol></nav> places yielded <li> under the <ol> yield-ancestor (canonical resolver path)', async () => {
    // `<Breadcrumb>` resolves to outer `<nav>` with yield-ancestor
    // `<ol>`; `<BreadcrumbItem>` resolves to `<li>`. The yield-ancestor
    // preference must substitute `<Breadcrumb>` as `<ol>` so the
    // yielded `<li>` validates against `<ol>`, not `<nav>`. The Glint
    // path (`applyResolution`) always did this; the canonical-resolver
    // path (`buildResolutionMaps`) did NOT — it discarded the
    // yield-ancestor and FP-fired element-permitted-content/-parent.
    // `HVE_GLINT=0` forces that previously-broken path; assert it's
    // fixed (the shared `chooseSubstitution` now backs both).
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '0';
    try {
      const r = await validate('breadcrumb-consumer.gjs');
      const offenders = r.messages.filter(
        (m) => m.rule === 'element-permitted-content' || m.rule === 'element-permitted-parent',
      );
      expect(
        offenders,
        `element-permitted-content / -parent must not fire — <li> lands inside the <ol> yield-ancestor; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('issue #33: same fixture is also clean on the Glint path', async () => {
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validate('breadcrumb-consumer.gjs');
      const offenders = r.messages.filter(
        (m) => m.rule === 'element-permitted-content' || m.rule === 'element-permitted-parent',
      );
      expect(
        offenders,
        `element-permitted-content / -parent must not fire on the Glint path either; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('multi-template-file-consumer: a component in a multi-template file does NOT get tagged with the first template block\'s root element', async () => {
    // Mirrors limber's `apps/repl/app/templates/docs/support/api.gts`
    // pattern: a file with multiple top-level `<template>` blocks
    // (TOC `<Live>` first → `<span>`, class `<Wrapper>` second →
    // `<div>...<p>{{yield}}</p>`). The leaf-fallback resolution
    // path picks `roots[0]` (Live's `<span>`) for ANY component
    // declared in the file — wrong tag for Wrapper. Downstream:
    // `<ul><Wrapper>...</Wrapper></ul>` becomes `<ul><span>...
    // </span></ul>`, FP-firing `element-permitted-content`
    // ("<span> not permitted under <ul>" — `<ul>` requires
    // `<li>`).
    //
    // Fix: when the declaring file has >1 `<template>` block,
    // skip the leaf-fallback (declaration→template matching is
    // deferred). The component stays at its underlying Glint
    // Element type (typically 'transparent' for declarations
    // without a Signature).
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validate('multi-template-file-consumer.gts');
      const offenders = r.messages.filter(
        (m) =>
          m.rule === 'element-permitted-content' &&
          /span/.test(m.message ?? '') &&
          /ul/.test(m.message ?? ''),
      );
      expect(
        offenders,
        `<span> not permitted under <ul> (FP from leaf-fallback picking the wrong template's root) must not fire; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('input-type-dynamic-consumer: substituted <input> with DYNAMIC `type` (mustache-bound) does NOT trip `attribute-allowed-values`', async () => {
    // The chain-attr extractor records `type={{this.computedType}}`
    // as the 3-space DynamicValue placeholder. Consumer has only
    // non-Glimmer attrs, so source-side `tryInjectInputType` finds
    // no slot and falls through to the hook-time setAttribute
    // path. Pre-fix, the placeholder slipped through
    // `isLiteralSafeForAttr` (whitespace passed the no-HTML-
    // altering-chars regex), got stored as a "safe literal", and
    // the hook injected the literal whitespace value
    // (`type="   "`) — html-validate's `attribute-allowed-values`
    // then FP-fired with "invalid value '   '" because `   ` isn't
    // in `<input type>`'s enum.
    //
    // Post-fix, `isLiteralSafeForAttr` rejects the DynamicValue
    // placeholder; the hook injects a real DynamicValue and
    // `attribute-allowed-values` correctly skips the enum check.
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validate('input-type-dynamic-consumer.gts', { 'void-style': 'off' });
      const offenders = r.messages.filter((m) => m.rule === 'attribute-allowed-values');
      expect(
        offenders,
        `attribute-allowed-values must not fire when chain has dynamic type; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('h32-dynamic-submit-type: wcag/h32 must NOT fire when the only candidate submit is <button type="{{dynamic}}">', async () => {
    // The blanker can't determine the runtime button type; could be
    // 'submit' (form valid) or 'button' (form invalid). Mel #38
    // principle: suppress the technique-rule on uncertainty. The
    // suppression lands as a per-element `disableRules` on the form
    // via `processElement`; the rule would fire on the blanked
    // output regardless (the placeholder type isn't recognized as
    // 'submit'), so the disable is well-targeted.
    const r = await validate('h32-dynamic-submit-type.gts');
    const offenders = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      offenders,
      `wcag/h32 must not fire on a form whose only submit candidate is <button type='{{dynamic}}'>; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('h32-input-dynamic-type: wcag/h32 must NOT fire when the only candidate submit is <input type="{{dynamic}}">', async () => {
    const r = await validate('h32-input-dynamic-type.gts');
    const offenders = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      offenders,
      `wcag/h32 must not fire on a form whose only submit candidate is <input type='{{dynamic}}'>; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('regression: element-permitted-content fires on <th> directly under <thead> (no <tr> wrapper) — table suppressions must not mask this real-bug shape', async () => {
    // Unmasked by fix/38's per-element migration. Regression guard
    // against future broadening of table-cell suppressions.
    const r = await validate('regression-th-under-thead-without-tr.gts');
    const offenders = r.messages.filter((m) => m.rule === 'element-permitted-content');
    expect(
      offenders.length,
      `element-permitted-content must fire on <th>-under-<thead>-without-<tr>; got: ${JSON.stringify(r.messages)}`,
    ).toBeGreaterThan(0);
  });

  it('regression: element-permitted-content fires on <div> inside <span> — wrapper suppressions must not mask block-in-phrasing', async () => {
    // Unmasked by fix/38's per-element migration. Regression guard
    // against future broadening of wrapper-non-native suppressions.
    const r = await validate('regression-div-inside-span.gts');
    const offenders = r.messages.filter((m) => m.rule === 'element-permitted-content');
    expect(
      offenders.length,
      `element-permitted-content must fire on <div>-inside-<span>; got: ${JSON.stringify(r.messages)}`,
    ).toBeGreaterThan(0);
  });

  it('regression: element-permitted-content fires when a non-native <div>-resolving child sits inside a non-native <ul>-resolving wrapper — must not over-suppress', async () => {
    // Unmasked by fix/38's per-element migration. During fix/38
    // development a broader detection attempt masked this case (see
    // the reverted extension); this test ensures any future attempt
    // keeps the real bug firing. The wrapper's internal template is
    // `<ul>{{yield}}</ul>` so the wrapper IS the runtime parent and
    // the child IS its runtime child — masking would silence a real
    // <ul><div></ul> at runtime.
    const r = await validate('regression-pascalcase-div-under-pascalcase-ul.gts');
    const offenders = r.messages.filter((m) => m.rule === 'element-permitted-content');
    expect(
      offenders.length,
      `element-permitted-content must fire when both wrapper and child are non-native PascalCase with mismatched runtime tags; got: ${JSON.stringify(r.messages)}`,
    ).toBeGreaterThan(0);
  });

  it('table-component-th: wcag/h63 must NOT fire on a <th> produced by a PascalCase component resolved via Glint to <th>', async () => {
    // tableHasGlimmerObscuredCells treats component-resolved <th>/
    // <td>/<tr> as cell tags that trigger the table's suppression.
    // The per-<th> disable collection must also recognize component-
    // resolved <th>, not just literal ones — otherwise the
    // substituted output fires h63 even though we detected the
    // table as Glimmer-opaque.
    const r = await validate('table-component-th.gts');
    const offenders = r.messages.filter((m) => m.rule === 'wcag/h63');
    expect(
      offenders,
      `wcag/h63 must not fire on component-resolved <th>; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('regression-sibling-structural-literal: element-permitted-content fires on a real-bug structural literal that sits beside an unrelated transparent dotted curried child', async () => {
    // STRUCTURAL_CONTENT_PARENTS + transparent-dotted-child branch
    // must scope its suppression to the dotted child's subtree only.
    // A sibling structural-child literal (here, a <tr> directly under
    // <select>) is a real bug regardless of the dotted child's
    // yield-chain opacity and must still fire.
    const r = await validate('regression-sibling-structural-literal-under-structural-wrapper.gts');
    const offenders = r.messages.filter((m) => m.rule === 'element-permitted-content');
    expect(
      offenders.length,
      `element-permitted-content must fire on the sibling <tr> under <select>; got: ${JSON.stringify(r.messages)}`,
    ).toBeGreaterThan(0);
  });

  it('h32-yield-and-ambiguous-submit: wcag/h32 must NOT fire when a form has BOTH {{yield}} AND a dynamic-typed button', async () => {
    // Composes the yield and ambiguous-submit suppression triggers.
    // Pre-migration the ambiguous flag set hasStaticSubmit=true and
    // blocked suppression even alongside yield; new logic keeps the
    // two signals independent so either alone (or both) triggers.
    const r = await validate('h32-yield-and-ambiguous-submit.gts');
    const offenders = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      offenders,
      `wcag/h32 must not fire when a form has both yield and a dynamic-typed button; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('h32-input-splat-attrs: wcag/h32 must NOT fire when an <input ...attributes> may carry type=submit via the splat', async () => {
    const r = await validate('h32-input-splat-attrs.gts');
    const offenders = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      offenders,
      `wcag/h32 must not fire on a form with <input ...attributes>; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('h67-img-dynamic-title-patterns: wcag/h67 must NOT fire on any <img alt=""> whose title is dynamic — bare-mustache, ConcatStatement w/ whitespace-only literals, or inside {{#if}}', async () => {
    // H67: a decorative image (empty alt) must not carry a title
    // attribute — the title would surface to AT, defeating the
    // decorative declaration. When the title is dynamic in a way the
    // blanker can't model (bare mustache, whitespace-only literals
    // around a mustache, or inside a conditional), the runtime title
    // may legitimately be empty. Suppress on uncertainty per Mel #38.
    //
    // Three patterns in one fixture, asserted together — if any
    // imgHasDynamicTitle branch breaks, the count is non-zero and
    // the diagnostic message lists the actual messages so you can
    // tell which <img> fired.
    const r = await validate('h67-img-dynamic-title-patterns.gts');
    const offenders = r.messages.filter((m) => m.rule === 'wcag/h67');
    expect(
      offenders,
      `wcag/h67 must not fire on any <img> with a dynamic title (bare mustache / whitespace-literal concat / inside {{#if}}); got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('multi-img-h67: wcag/h67 suppression is per-element — a dynamic-title img is suppressed but a sibling with a static-non-empty title still fires', async () => {
    // Per-element disable scope guard for h67. The first img has
    // title='{{tip}}' (runtime title may be empty) and gets
    // suppressed. The second img has title='Some literal' (static
    // non-empty) — a real H67 violation on a decorative image
    // (alt='' + title='something'). With a file-level directive
    // the real violation would be silenced; per-element keeps it.
    const r = await validate('multi-img-h67.gts');
    const offenders = r.messages.filter((m) => m.rule === 'wcag/h67');
    expect(
      offenders.length,
      `wcag/h67 must fire on the second img with a static-non-empty title even though the first img's dynamic title is suppressed; got: ${JSON.stringify(r.messages)}`,
    ).toBe(1);
    // The fixture's second img is at line 19; the first at line 18.
    expect(
      offenders[0]?.line,
      `h67 message must come from the second img (line 19), not the first (suppressed); got: ${JSON.stringify(offenders)}`,
    ).toBe(19);
  });

  it('multi-table-mixed: wcag/h63 suppression is per-element — a cell-loop table is suppressed but a genuinely-irregular sibling table still fires', async () => {
    // Per-element disable scope guard. The first table contains a
    // cell-loop ({{#each}}<td>) and gets its <th>s individually
    // disabled. The second table is plain static markup with a
    // genuine row-width mismatch (4 <th> vs 3 <td>) — its <th>s
    // should fire h63 normally. With a file-level directive the
    // real bug would be silenced too; per-element keeps both rules.
    const r = await validate('multi-table-mixed.gts');
    const offenders = r.messages.filter((m) => m.rule === 'wcag/h63');
    expect(
      offenders.length,
      `wcag/h63 must fire on the second (genuinely-irregular) table even though the first table's cell-loop is suppressed; got: ${JSON.stringify(r.messages)}`,
    ).toBeGreaterThan(0);
    // Locate the second table's <th></th> (line 41 in the fixture)
    // and verify the message is reported there, not on the first
    // table's <th></th> (line 25).
    expect(
      offenders.every((m) => m.line >= 38),
      `h63 messages must come from the second table (line >= 38), not the first (suppressed); got: ${JSON.stringify(offenders)}`,
    ).toBe(true);
  });

  it('table-component-rows: wcag/h63 must NOT fire when rows are rendered by PascalCase components resolving to <tr>', async () => {
    // Same family as table-cell-each: the blanker can't see the
    // runtime row content. Here, <MyRow @label='…' /> resolves via
    // Glint to <tr>, so the blanker substitutes the tag — but the
    // row's children (the <td> cells) live in MyRow's own template,
    // not at the call site. The blanked output has empty <tr></tr>
    // rows against a static <thead> of 4 <th>. `isSimpleTable`
    // decides "not simple" → requires scope on every <th> → fires.
    //
    // Glimmer made the row content invisible → suppress the
    // technique-rule. Same conditional-suppression principle as
    // wcag/h32 / wcag/h71 here.
    const r = await validate('table-component-rows.gts');
    const offenders = r.messages.filter((m) => m.rule === 'wcag/h63');
    expect(
      offenders,
      `wcag/h63 must not fire when the blanker has substituted row-component invocations into empty <tr> elements; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('table-cell-each: wcag/h63 must NOT fire when a row uses {{#each}} to generate cells', async () => {
    // Mel #38 / our cell-loop FP. html-validate's H63 has a
    // simple-table exemption but `isSimpleTable` compares raw cell
    // counts across rows. The blanker leaves {{#each}}<td>…</td>
    // {{/each}} as a single representative iteration, so a body
    // row appears to have 2 cells against a static <thead> of 4
    // — rule decides "not simple" → requires scope on every <th>
    // → fires on the empty corner <th></th>.
    //
    // The runtime table is regular. Our blanker created the
    // appearance of irregularity. Same shape as wcag/h32 / wcag/h71
    // suppressions: Glimmer made structure invisible → suppress
    // the technique-rule.
    const r = await validate('table-cell-each.gts');
    const offenders = r.messages.filter((m) => m.rule === 'wcag/h63');
    expect(
      offenders,
      `wcag/h63 must not fire on a table whose row widths only mismatch because the blanker collapsed {{#each}} cells; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('glint-resolved-form-consumer: wcag/h32 suppression fires when wrapper is Glint-resolved to <form>', async () => {
    // Regression for fd7fb2a: the `wcag/h32` heuristic in
    // `detectStructuralYieldRules` was checking `stmt.tag === 'form'`
    // (only LITERAL `<form>`). Components like HDS's `<HdsForm>` that
    // resolve to `<form>` via Glint were missed — substituted
    // output had `<form>` but `disableForRules` didn't include
    // wcag/h32, FP-firing on what's a yield-bearing form.
    //
    // Post-fix: the heuristic uses `stmtResolved` (Glint-resolved
    // tag OR literal native tag). Both consumer-side `<form>` and
    // `<MyForm>` substituted to `<form>` get wcag/h32 added to
    // `disableForRules`.
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validate('glint-resolved-form-consumer.gts');
      const offenders = r.messages.filter((m) => m.rule === 'wcag/h32');
      expect(
        offenders,
        `wcag/h32 must not fire on Glint-resolved-to-<form> wrapper that yields without inline submit; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('details-with-curried-component.gts: element-required-content does not fire on self-closing component that resolves to <details>', async () => {
    // Ecosystem regression (proapi-webapp `punch-card.gts`):
    // a self-closing component invocation that resolves to <details>
    // gets substituted to `<details>...</details>` (paired tags around
    // empty body) — the addon's `<summary>` lives inside its template,
    // not in the consumer's call site, so the blanker can't see it.
    // html-validate fires `element-required-content` ("<details>
    // requires <summary>") on the substituted shape.
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validate('details-with-curried-component.gts');
      const offenders = r.messages.filter((m) => m.rule === 'element-required-content');
      expect(
        offenders,
        `element-required-content must not fire on substituted <details> from a self-closing component invocation; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('linkto-aria-label: aria-label on <LinkTo> does not fire aria-label-misuse', async () => {
    // <LinkTo> is substituted to <a> via the built-in components map,
    // and block-form substitution injects an href placeholder so the
    // resulting anchor counts as interactive for html-validate's
    // aria-label-misuse rule. Historically the missing href injection
    // FP-fired here even though at runtime LinkTo always renders an
    // <a> with a computed href; the hand-written <a href=...>
    // reference in the same fixture captures the intended behavior.
    const r = await validate('linkto-aria-label.hbs');
    const ariaErrors = r.messages.filter((m) => m.rule === 'aria-label-misuse');
    expect(ariaErrors).toHaveLength(0);
  });

  it('yield-only-form: wcag/h32 must NOT fire when a thin <form> wrapper yields its body', async () => {
    // `<form ...>{{yield}}</form>` blanks to an empty form body, so a
    // length-preserving in-place injection of a synthetic submit-button
    // child isn't workable (`{{yield}}` is 8 chars, `<button type=submit>`
    // is 19). Instead, `detectStructuralYieldRules` flags the file and
    // the transformer prepends a Source-level `<!--html-validate-disable
    // wcag/h32-->` directive — the same mechanism we use for
    // `no-unused-disable` on branched ranges.
    const r = await validate('yield-only-form.gts');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      h32,
      `wcag/h32 must not fire on a yield-only <form> wrapper; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('yield-only-fieldset: wcag/h71 must NOT fire when a thin <fieldset> wrapper yields its body', async () => {
    // Same shape as yield-only-form but for `<fieldset>` + `wcag/h71`
    // (`<fieldset> must have a <legend> as the first child`). Consumer
    // supplies the legend via the yielded body.
    const r = await validate('yield-only-fieldset.gts');
    const h71 = r.messages.filter((m) => m.rule === 'wcag/h71');
    expect(
      h71,
      `wcag/h71 must not fire on a yield-only <fieldset> wrapper; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('yield-only-form: wcag/h32 also suppressed when yield is wrapped in non-submit markup', async () => {
    // `<form><div>{{yield}}</div></form>` — the wrapper isn't a submit-
    // style element, so the suppression should still kick in. The
    // earlier opaque-only check missed this; the current detection
    // looks for yield + absence of statically-detectable submit.
    const r = await validate('yield-only-form-with-wrapper.gts');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      h32,
      `wcag/h32 must not fire on a yield-bearing form with wrapper markup; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('yield-only-form: NO suppression when a static submit button is present alongside yield', async () => {
    // `<form>{{yield}}<button type='submit'></button></form>` — wcag/h32
    // wouldn't fire (submit is statically present). Suppression must
    // NOT activate, otherwise the injected
    // `<!--html-validate-disable wcag/h32-->` would itself trigger
    // `no-unused-disable`.
    const r = await validate('yield-form-with-static-submit.gts');
    const unused = r.messages.filter((m) => m.rule === 'no-unused-disable');
    expect(
      unused,
      `no-unused-disable must not fire — wcag/h32 suppression shouldn't activate when submit is statically present; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('yield-only-form: <button type="button"> alongside yield does NOT disqualify suppression', async () => {
    // An explicit non-submit `<button>` must not be treated as a
    // submit. wcag/h32 still FP-fires on the blanked output (no
    // statically-detectable submit), so suppression must remain active.
    const r = await validate('yield-form-with-non-submit-button.gts');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      h32,
      `wcag/h32 must not fire — <button type='button'> isn't a submit and shouldn't disqualify suppression; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('yield-only-form: <input type="Submit"> (uppercase) IS a static submit — suppression must NOT activate', async () => {
    // HTML attribute values are ASCII case-insensitive. html-validate
    // recognizes `type='Submit'` as a real submit, so wcag/h32 wouldn't
    // fire — and our injected disable would itself trigger
    // `no-unused-disable`. Static-submit detection must normalize.
    const r = await validate('yield-form-with-uppercase-submit-input.gts');
    const unused = r.messages.filter((m) => m.rule === 'no-unused-disable');
    expect(
      unused,
      `no-unused-disable must not fire — case-insensitive submit detection should keep suppression off; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('issue #34: self-closing component that resolves to <form> with its OWN static submit does not FP-fire wcag/h32', async () => {
    // `<FormWithSubmit />` resolves to `<form>`; the component's
    // template has a `<button type="submit">`, but the blanker only
    // substitutes the root tag, so the consumer's call site is an
    // empty substituted `<form>`. Pre-fix, `detectStructuralYieldRules`
    // only suppressed yield-bearing forms — a self-closing component
    // invocation had no yield and no consumer-side submit, so wcag/h32
    // FP-fired at the invocation. The form's submit is the component's
    // responsibility (caught if its own file is genuinely submit-less).
    const r = await validate('component-form-own-submit-consumer.gjs');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      h32,
      `wcag/h32 must not fire on a component invocation that resolves to <form> and owns its submit; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
    // The suppression must be load-bearing, not gratuitous: wcag/h32
    // genuinely fires on the empty substituted <form>, so the injected
    // disable directive is used and `no-unused-disable` stays quiet.
    const unused = r.messages.filter((m) => m.rule === 'no-unused-disable');
    expect(
      unused,
      `no-unused-disable must not fire — the wcag/h32 suppression is load-bearing here; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('fieldset-with-component-content: `<fieldset>{{#if (has-block)}}{{yield}}{{else}}<C />{{/if}}</fieldset>` does not FP-fire wcag/h71 in either pass', async () => {
    // Multipass case where the fieldset branches into either yield
    // (program) or component invocation (inverse). Without the
    // opaque-content fix, the inverse pass sees `<CurriedFields />`
    // (no yield, no static legend) and lets wcag/h71 fire, even
    // though the component may render its own `<legend>` at runtime.
    // Mirrors ember-primitives' `one-time-password/input.gts:171`.
    const r = await validate('fieldset-with-component-content.gts');
    const h71 = r.messages.filter((m) => m.rule === 'wcag/h71');
    expect(
      h71,
      `wcag/h71 must not fire on either arm; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('input-driven-form: `<form {{on "input" …}}>` does not FP-fire wcag/h32', async () => {
    // Search-as-you-type / live-filter pattern. `{{on "input"}}` updates
    // on every keystroke; a separate submit button is ceremonial. Plugin
    // suppresses wcag/h32 so the user doesn't scatter
    // `<!--html-validate-disable-next wcag/h32-->` directives.
    const r = await validate('input-driven-form.gts');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      h32,
      `wcag/h32 must not fire on input-driven forms; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('change-driven-form: `<form {{on "change" …}}>` does not FP-fire wcag/h32', async () => {
    // Commit-on-blur / per-field-commit pattern. `{{on "change"}}` fires
    // when a field is committed (input blurs, select changes); the
    // form's action runs per-field rather than at a final submit, so a
    // submit button is ceremonial. Same suppression as `{{on "input"}}`.
    const r = await validate('change-driven-form.gts');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      h32,
      `wcag/h32 must not fire on change-driven forms; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('yield-only-form: asymmetric {{#if}}/{{else}} branches — multipass passes get branch-correct suppression', async () => {
    // Program arm has `{{yield}}`, inverse arm has `<button type='submit'>`.
    // Without per-branch detection, the program pass's `disableForRules`
    // would skip wcag/h32 (because the walker saw the inverse arm's
    // submit too) and the FP would surface. With per-branch detection,
    // each pass's disable list matches its own blanked content. The
    // inverse pass must NOT inject the disable (no-unused-disable
    // cascade prevention).
    const r = await validate('yield-form-asymmetric-branches.gts');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    const unused = r.messages.filter((m) => m.rule === 'no-unused-disable');
    expect(
      h32,
      `wcag/h32 must not fire on the yield-only program arm; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
    expect(
      unused,
      `no-unused-disable must not fire on the inverse arm (submit visible); got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('yield-only-form: branched {{#if}}/{{else}} with yield in BOTH arms — multipass directive must disable BOTH no-unused-disable and wcag/h32', async () => {
    // `<form>{{yield}}</form>` vs `<div>{{yield}}</div>` toggle —
    // multipass triggers (different root elements per arm), so the
    // injected directive must carry BOTH `no-unused-disable` and
    // `wcag/h32`. html-validate's directive grammar requires
    // COMMA-separated rule names: a space-separated list silently
    // disables only the first rule, leaving wcag/h32 to fire on the
    // blanked program-pass output. This test catches that regression.
    // (Mirrors HDS `form/index.gts`.)
    const r = await validate('yield-form-branched-both-yield.gts');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    const unused = r.messages.filter((m) => m.rule === 'no-unused-disable');
    expect(
      h32,
      `wcag/h32 must not fire — directive must comma-separate rules so BOTH get disabled; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
    expect(
      unused,
      `no-unused-disable must not fire on either arm; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('yield-only-form: form in BLANKED-OUT branch must not leak wcag/h32 suppression into the active pass', async () => {
    // Two `<form>` nodes, one per arm of `{{#if @showYieldedForm}}`:
    //   - program arm: `<form>{{yield}}</form>` (legit suppression target)
    //   - inverse arm: `<form><textarea/></form>` (NO submit, NO yield;
    //     this is a real wcag/h32 violation that must be reported)
    //
    // Without a branch-aware top-level traversal in
    // `detectStructuralYieldRules`, both forms get visited and the
    // walker adds wcag/h32 to disableForRules for BOTH passes —
    // silently suppressing the inverse arm's real bug. The test
    // asserts the real bug surfaces, i.e. wcag/h32 is not silently
    // hidden by the program arm's legitimate suppression.
    const r = await validate('form-in-blanked-out-branch.gts');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      h32,
      `wcag/h32 must fire on the inverse arm's genuinely-broken form; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(1);
  });

  it('yield-only-form: <SubmitButton /> resolving to <button type="submit"> IS a static submit — no suppression', async () => {
    // The component's splatted root is `<button type='submit'
    // ...attributes>`; Glint resolves <SubmitButton /> to native
    // `<button>` with static `type='submit'`. After substitution the
    // blanked output has a real submit, so wcag/h32 wouldn't fire.
    // Suppression must NOT activate or no-unused-disable cascades on
    // the injected disable directive.
    //
    // Two levers make this assertion meaningful:
    //   1. HVE_GLINT=1 — component-as-submit detection requires Glint
    //      to resolve <SubmitButton /> to <button>. Without Glint the
    //      detection returns false, suppression activates, and a
    //      naive `no-unused-disable.length === 0` check would pass
    //      for the wrong reason (the directive would be "used" because
    //      wcag/h32 actually fires on the unsubstituted output).
    //   2. `wcag/h32: 'off'` via rulesOverride — with the rule off,
    //      any injected `<!--html-validate-disable wcag/h32-->`
    //      becomes immediately unused, surfacing as
    //      `no-unused-disable`. So absence of `no-unused-disable` is
    //      a POSITIVE assertion that no directive was injected, i.e.
    //      that component-as-submit was correctly recognized and
    //      suppression was skipped.
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validateRaw('yield-form-with-component-submit.gts', {
        'wcag/h32': 'off',
      });
      const unused = r.messages.filter((m) => m.rule === 'no-unused-disable');
      expect(
        unused,
        `no-unused-disable must not fire — with wcag/h32=off, any injected directive becomes unused; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('yield-only-form (.hbs): negative offset/column from prefix directive does not break diagnostics', async () => {
    // The .hbs path normally uses line/column/offset = 1/1/0; with a
    // prefix directive it goes negative. Verify html-validate handles
    // negative offsets cleanly (no crash, no spurious diagnostics on
    // the directive itself) for the same yield-only pattern in classic
    // .hbs.
    const r = await validate('yield-only-form.hbs');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      h32,
      `wcag/h32 must not fire on yield-only <form> in classic .hbs; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('form-submit-in-else: wcag/h32 surfaces correctly under multipass', async () => {
    // Fixture has a submit button in the {{else}} branch (Send) and a
    // type='button' in the program branch (Stop). Under multipass:
    //   - program branch: form has no submit → wcag/h32 fires (real
    //     concern: in this state the user cannot trigger submission via
    //     a literal button, only via Enter on the textarea)
    //   - inverse branch: form has submit → no h32
    // The single-branch heuristic that historically masked this still
    // exists as the fallback when HVE_MAX_CONDITIONAL_BRANCHES=0; its
    // behavior is covered by the unit tests in `test/blank.test.ts`.
    const r = await validate('form-submit-in-else.gts');
    const wcagH32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(wcagH32).toHaveLength(1);
  });

  it('imported-const-resolution: {{NAME}} resolves against `import { NAME } from \'./sibling\'`', async () => {
    // The fixture imports `ROUTE_DIR = 'bogus'` from `./imported-routes.ts`
    // and references it as `<p dir={{ROUTE_DIR}}>`. With cross-file
    // resolution working, the blanker substitutes the literal `'bogus'`
    // and `attribute-allowed-values` fires on the invalid `dir` value.
    const r = await validate('imported-const-resolution.gts');
    const dirErrors = r.messages.filter(
      (m) => m.rule === 'attribute-allowed-values' && /dir/i.test(m.message ?? ''),
    );
    expect(
      dirErrors,
      `expected attribute-allowed-values on dir; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(1);
  });

  it("this-field-resolution: {{this.field}} resolves against the class field's initializer", async () => {
    // The fixture has `textDir = 'bogus'` and `<p dir={{this.textDir}}>`.
    // With class-field resolution working, the blanker substitutes the
    // literal `'bogus'` into the attribute and html-validate's
    // `attribute-allowed-values` rule fires (`dir` has an enum:
    // ltr/rtl/auto). Without resolution, the mustache becomes
    // DynamicValue and no enum check happens.
    const r = await validate('this-field-resolution.gts');
    const dirErrors = r.messages.filter(
      (m) => m.rule === 'attribute-allowed-values' && /dir/i.test(m.message ?? ''),
    );
    expect(
      dirErrors,
      `expected attribute-allowed-values on dir; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(1);
  });

  it('multipass-multi-template: no-unused-disable suppression is scoped to the branched template, not the whole file', async () => {
    // Two top-level templates in one file. Header (no branches) has a
    // directive that's really unused — `no-unused-disable` MUST fire
    // there. Main (branched) has the FP pattern — `no-unused-disable`
    // must NOT fire there. File-level suppression would silence both;
    // template-range scoping silences only the branched template.
    const r = await validate('multipass-multi-template.gts');
    const unused = r.messages.filter((m) => m.rule === 'no-unused-disable');
    expect(
      unused,
      `expected exactly one no-unused-disable (from Header); got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(1);
    // The Header directive lives at the top of the file; the Main
    // directive is well below. Assert the surviving message points at
    // the Header range, not the Main range.
    expect(
      unused[0]!.line,
      `surviving no-unused-disable should be Header's; got line ${unused[0]!.line}`,
    ).toBeLessThan(20);
  });

  it('multipass-yield-only-branch: wcag/h32 must not fire when the no-submit branch is just `{{yield}}`', async () => {
    // The form has a default submit in the `(has-block)`-false branch
    // and a `{{yield}}` in the true branch. The yield is opaque — the
    // consumer might fill it with their own submit, so we can't claim
    // the form lacks one. Multipass currently validates the blanked
    // yield-only branch as a real DOM and FP-fires `wcag/h32`.
    const r = await validate('multipass-yield-only-branch.gts');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      h32,
      `wcag/h32 must not fire on yield-only branches; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('multipass-disable-needed-in-some-branch: no-unused-disable does NOT survive when the directive is load-bearing in another pass', async () => {
    // Catch-22: a `disable-next wcag/h32` on `<form>` is needed in the
    // inner=program branch (no submit button → h32 fires → suppressed)
    // but looks "unused" in the inner=inverse branch (submit present →
    // h32 doesn't fire). Naive dedupe surfaces no-unused-disable from
    // the inverse pass. Correct behavior: drop it because another pass
    // had the directive visible and used it (no `no-unused-disable`
    // there).
    const r = await validate('multipass-disable-needed-in-some-branch.gts');
    const unused = r.messages.filter((m) => m.rule === 'no-unused-disable');
    const h32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      unused,
      `no-unused-disable must not fire when the directive was load-bearing in another branch; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
    expect(
      h32,
      `wcag/h32 should be suppressed by the directive; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('multipass-disable-needed-unique-landmark: catch-22 also fixed in the no-dedupe (VS Code) path', async () => {
    // Same shape as `multipass-disable-needed-in-some-branch.gts` but
    // with `unique-landmark` standing in for `wcag/h32`. The fix here
    // is not in the report-side dedupe — it's an inline directive
    // prepended to each branched Source by the transformer, so the
    // catch-22 disappears regardless of whether the caller runs
    // `dedupeMultipassReport`. Assert it's gone in both the dedupe
    // path AND the raw path (mirroring the html-validate VS Code
    // extension, which doesn't run our dedupe).
    for (const [label, run] of [
      ['dedupe', validate],
      ['raw', validateRaw],
    ] as const) {
      const r = await run('multipass-disable-needed-unique-landmark.gts');
      const unused = r.messages.filter((m) => m.rule === 'no-unused-disable');
      const landmark = r.messages.filter((m) => m.rule === 'unique-landmark');
      expect(
        unused,
        `[${label}] no-unused-disable must not fire when the directive was load-bearing in another branch; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
      expect(
        landmark,
        `[${label}] unique-landmark should be suppressed by the directive; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    }
  });

  it('if-else-branch-errors: errors in BOTH branches are reported (multipass default)', async () => {
    // Fixture has `<h2></h2>` in the program branch and `<h1></h1>` in the
    // inverse — both empty headings. Multipass (default) yields one
    // Source per branch combination; html-validate validates each
    // independently and both errors surface.
    const r = await validate('if-else-branch-errors.gts');
    const empty = r.messages.filter((m) => m.rule === 'empty-heading');
    expect(
      empty,
      `expected empty-heading in BOTH if and else branches; got: ${JSON.stringify(empty)}`,
    ).toHaveLength(2);
  });

  describe('.hbs (classic Ember templates)', () => {
    // The .hbs path skips content-tag (no <template> wrapper), the JS-
    // portion scope (no JS), and Glint integration. Components blank
    // transparently (open/close tags removed; children float into the
    // parent's content model). Built-in <Input>/<Textarea>/<LinkTo>
    // substitute to native tags. The fixture exercises blocks
    // (#if/#each/#let), modifiers, splattributes, classic helpers
    // ({{outlet}}), concat-mustaches, comments, and PascalCase
    // components. Assertions verify the transformer pipeline doesn't
    // crash or leak parser noise.
    it('parses without transformer artifacts', async () => {
      const r = await validate('classic-template.hbs');
      // Things that would indicate a transformer bug:
      //   - parser-error: html-validate couldn't parse our blanked output
      //   - element-name on a PascalCase tag: tag leaked through to html-validate
      //   - close-order: blanker truncated/leaked a block
      const artifacts = r.messages.filter(
        (m) =>
          m.rule === 'parser-error' ||
          (m.rule === 'element-name' && /\b[A-Z][a-z]/.test(m.message ?? '')) ||
          m.rule === 'close-order',
      );
      expect(
        artifacts,
        `transformer-artifact errors leaked: ${JSON.stringify(artifacts)}`,
      ).toHaveLength(0);
    });

    it('classic helpers like {{outlet}} blank without leaking', async () => {
      const r = await validate('classic-template.hbs');
      // {{outlet}} is just a MustacheStatement; should blank to spaces.
      // If we crashed or left raw text, we'd see content-related errors.
      const outletNoise = r.messages.filter((m) =>
        /outlet/i.test(m.message ?? '') || /outlet/i.test(m.context?.name ?? ''),
      );
      expect(outletNoise).toHaveLength(0);
    });

    it('PascalCase component invocations blank transparently (no element-name errors)', async () => {
      const r = await validate('classic-template.hbs');
      // <Button @label='Save' /> blanks to whitespace (open/close tags
      // removed); children float to the actual parent. No PascalCase
      // tag leaks through to html-validate's parser.
      const pascalCaseErrors = r.messages.filter(
        (m) => m.rule === 'element-name' || m.rule === 'element-case',
      );
      expect(pascalCaseErrors).toHaveLength(0);
    });
  });

  it('dynamic-heading.gts: empty-heading does NOT fire on <h1>{{dynamic}}</h1>', async () => {
    // Regression test: a real-world FP report flagged
    //   <h1>{{or @title (if (isNode @period) (t '..') (t '..'))}}</h1>
    // The mustache doesn't statically resolve via tryStaticText, so the
    // h1's content blanks to whitespace. The blanker MUST register the
    // h1's offset in dynamicContentOffsets and processElement MUST
    // append a DynamicValue text node — otherwise empty-heading fires.
    const r = await validate('dynamic-heading.gts');
    const empty = r.messages.filter(
      (m) =>
        m.rule === 'empty-heading' ||
        m.rule === 'text-content' ||
        m.rule === 'empty-title',
    );
    expect(
      empty,
      `expected no empty-content errors on dynamic-heading.gts; got: ${JSON.stringify(empty)}`,
    ).toHaveLength(0);
  });

  it('classic-resolver-mustache-bound-attrs.hbs: classic-resolved <img> with addon-side `src={{this.src}}` does not FP-fire element-required-attributes', async () => {
    // Regression for the by-name resolver's mustache-bound-attr projection.
    // Addon's template binds `src={{this.src}}` (mustache, not literal).
    // Without hook-time injection the source-side blank slots in the
    // consumer (`@src="…"`, `@width={{100}}`) are too narrow to fit the
    // projected `src='   '` placeholder, and `element-required-attributes`
    // FP-fires on the substituted <img>.
    //
    // The fix: when the resolved tag is <img> and the addon records
    // `src` (or `alt`) in `attrCtx.attrs` — including the
    // DYNAMIC_VALUE_PLACEHOLDER for mustache-bound values — push the
    // consumer's offset to `imgSplatSrcOffsets` / `imgSplatAltOffsets`
    // per-attr, the same hook the `<img ...attributes>` narrow-slot
    // fix uses (PR #13). Per-attr precision sidesteps the FN risk of
    // injecting an unintended attr.
    //
    // Mirrors ember-website's `<ResponsiveImage @src="…" alt="" />`
    // pattern: addon binds `src={{this.src}}`, runtime <img> always
    // gets a src.
    const v = makeValidator();
    const fp = path.join(__dirname, 'glint-fixtures', 'classic-resolver-mustache-bound-attrs.hbs');
    const rawReport = await v.validateFile(fp);
    const messages = rawReport.results.flatMap((r) =>
      r.messages.map((m) => ({ rule: m.ruleId, line: m.line, column: m.column, message: m.message })),
    );
    const offenders = messages.filter(
      (m) => m.rule === 'element-required-attributes' || m.rule === 'wcag/h37',
    );
    expect(
      offenders,
      `element-required-attributes / wcag/h37 must not fire — addon-side src/alt are mustache-bound but exist; got: ${JSON.stringify(messages)}`,
    ).toHaveLength(0);
  });

  it('classic-resolver-no-import.hbs: PascalCase tag in `.hbs` resolves via container-style by-name lookup', async () => {
    // Classic Ember `.hbs` templates resolve PascalCase components
    // through the container resolver (kebab-case name → installed
    // addon's component template). No JS `import` is involved.
    //
    // Mirrors the ember-website `<EsCard>` pattern: in node_modules,
    // `classic-card-addon/addon/components/classic-card.hbs` renders
    // `<li class="..." ...attributes>{{yield}}</li>`. The consumer
    // wraps an inner `<ul>` in `<ClassicCard>` while inside an outer
    // `<ul>`. Without by-name resolution the wrapper transparent-blanks
    // and the inner `<ul>` floats to the outer `<ul>` →
    // `element-permitted-content` FP-fires.
    //
    // With by-name resolution, the plugin substitutes `<ClassicCard>`
    // to `<li>`, so the inner `<ul>` is correctly nested under `<li>`
    // (legal) under the outer `<ul>`.
    //
    // Validated from `test/glint-fixtures/` instead of `examples/` so
    // the resolver's node_modules walk finds the fake
    // `classic-card-addon` (the `examples/` dir doesn't have a sibling
    // node_modules of fixture addons; glint-fixtures does).
    const v = makeValidator();
    const fp = path.join(__dirname, 'glint-fixtures', 'classic-resolver-no-import.hbs');
    const rawReport = await v.validateFile(fp);
    const messages = rawReport.results.flatMap((r) =>
      r.messages.map((m) => ({ rule: m.ruleId, line: m.line, column: m.column, message: m.message })),
    );
    const offenders = messages.filter((m) => m.rule === 'element-permitted-content');
    expect(
      offenders,
      `element-permitted-content must not fire — by-name resolution should map <ClassicCard> to <li>; got: ${JSON.stringify(messages)}`,
    ).toHaveLength(0);
  });

  it('form-with-unresolved-component-submit.gts: wcag/h32 suppressed when form contains an unresolved component (may render submit)', async () => {
    // A `<form>` whose submit button is provided by an unresolved
    // PascalCase component (no Glint Element annotation, not in
    // node_modules, not a builtin) FP-fired wcag/h32 because the
    // static blanker couldn't see a submit candidate. Heuristic
    // extension in `elementYieldsAndLacksSubmit`: a form that lacks
    // a static submit BUT contains any unresolved component
    // invocation is treated as "may render submit" and gets the
    // rule suppressed. Same per-Source-suppression trade-off as
    // PR #17's yield-bearing-form case.
    const r = await validate('form-with-unresolved-component-submit.gts');
    const wcagH32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(
      wcagH32,
      `wcag/h32 must not fire — form contains an unresolved component child that may render submit; got: ${JSON.stringify(r.messages)}`,
    ).toHaveLength(0);
  });

  it('namespaced-classic-resolver.hbs: wcag/h32 suppressed via the unresolved-component-child heuristic', async () => {
    // Originally a `.fails()` test asserting future-intent: namespaced
    // `<Forms::TextInput>` isn't resolved by the classic-by-name
    // resolver (it only handles single-segment kebab names). The
    // wrapper transparent-blanks, leaving an empty `<form>` which
    // fires wcag/h32.
    //
    // Now passes naturally: the unresolved-component-child heuristic
    // in `elementYieldsAndLacksSubmit` recognizes `<Forms::TextInput>`
    // as a component our static analysis can't pin and treats it as
    // "may contain submit" — the form's wcag/h32 is suppressed for
    // the Source. (This is the same FP class that affects ANY form
    // whose submit comes from an unresolved component invocation —
    // a button-style component whose source isn't reachable.)
    //
    // Namespaced classic-resolver support is still missing as a
    // feature; this test is now passing for a different reason than
    // originally intended.
    const v = makeValidator();
    const fp = path.join(__dirname, 'glint-fixtures', 'namespaced-classic-resolver.hbs');
    const r = await v.validateFile(fp);
    const wcagH32 = r.results
      .flatMap((rr) => rr.messages)
      .filter((m) => m.ruleId === 'wcag/h32');
    expect(wcagH32).toHaveLength(0);
  });

  it.fails(
    'heuristic-masks-real-bug.gts: per-Source element-permitted-content suppression DOES mask real bugs elsewhere (documented trade-off)',
    async () => {
      // Documents the per-Source suppression trade-off: when a template
      // also contains an unresolvable curried-yield-hash shape (which
      // triggers case-B/C suppression), real bugs in the same Source
      // get masked too. Marked .fails — when the resolver eventually
      // pins all curried-yield-hash patterns precisely, suppression
      // narrows or disappears, this test starts to pass, and vitest
      // signals "remove .fails".
      const r = await validate('heuristic-masks-real-bug.gts');
      const offenders = r.messages.filter((m) => m.rule === 'element-permitted-content');
      expect(offenders.length).toBeGreaterThan(0);
    },
  );

  it('multi-level-dotted-yield-options.gts: heuristic suppression silences element-permitted-content for HDS `<HdsForm.Select.Field as |F|><F.Options><option>` shape (Glint mode)', async () => {
    // Ecosystem regression: this shape is the dominant FP class
    // when PR21's case-A/B suppression isn't extended to multi-level
    // dotted-namespace + curried-yield-hash chains.
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validate('multi-level-dotted-yield-options.gts');
      const offenders = r.messages.filter(
        (m) => m.rule === 'element-permitted-content' || m.rule === 'element-permitted-parent',
      );
      expect(
        offenders,
        `element-permitted-content / -parent must not fire on multi-level dotted yield-hash chain; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('multi-level-yield-chain-options.gts: heuristic suppression silences element-permitted-content for unresolvable wrappers with structural children', async () => {
    // Unresolvable curried sub-component case: `<F.Options>` is
    // `PassThrough` (no specific Element type), wrapped in a
    // `<FormSelectField>` whose outer Element is bare HTMLElement
    // (PR #12 → 'transparent'). Without the heuristic, `<option>`
    // floats to outer `<div>` → FP-fires
    // `element-permitted-content`. Cross-file yield-chain analysis
    // would resolve this precisely but is ~250+ lines and deferred.
    //
    // The heuristic instead recognizes the pattern: an unresolvable
    // PascalCase wrapper containing `<option>`/`<th>`/`<li>` children
    // is presumed to render the structurally-correct parent
    // (`<select>`/`<thead>`/`<ul>`) at runtime via yield chain.
    // Suppress `element-permitted-content` for the Source so the FP
    // doesn't surface.
    //
    // Same per-Source-suppression trade-off as Thread B's
    // wcag/h32 fix: real bugs at OTHER locations in the same template
    // get suppressed too. Acceptable given the volume of these FPs
    // in real-world Ember code (HDS's 172 entries, ember-website's
    // 99 entries).
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const r = await validate('multi-level-yield-chain-options.gts');
      const offenders = r.messages.filter((m) => m.rule === 'element-permitted-content');
      expect(
        offenders,
        `element-permitted-content must not fire — heuristic suppression should kick in; got: ${JSON.stringify(r.messages)}`,
      ).toHaveLength(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('glint-resolved-no-suppression.gts: heuristic must NOT suppress when Glint resolved the wrapper to a precise native tag', async () => {
    // Regression for the gating in `containsContentRestrictedStructuralChild`:
    // when Glint resolves `<C.Options>` to `<select>` (via PR #18), the
    // heuristic must defer to Glint and let `element-permitted-content`
    // fire on a real `<th>`-under-`<select>` violation. Earlier
    // implementations risked over-suppressing because the wrapper's tag
    // looked unresolvable (PascalCase/dotted) at the AST level.
    //
    // Lives under `test/glint-fixtures/` (not `examples/`) so the local
    // tsconfig.json wires up Glint type extraction for the fixture.
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const v = makeValidator();
      const fp = path.join(__dirname, 'glint-fixtures', 'glint-resolved-no-suppression.gts');
      const rawReport = await v.validateFile(fp);
      const messages = rawReport.results.flatMap((r) =>
        r.messages.map((m) => ({ rule: m.ruleId, line: m.line, column: m.column, message: m.message })),
      );
      const offenders = messages.filter((m) => m.rule === 'element-permitted-content');
      expect(
        offenders.length,
        `element-permitted-content MUST fire (Glint resolved <C.Options> to <select> and <th> is illegal there); got: ${JSON.stringify(messages)}`,
      ).toBeGreaterThan(0);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
  });

  it('builtins.hbs: <Input>/<Textarea>/<LinkTo> substitute to native tags', async () => {
    // The built-in Ember component map provides tag substitutions for
    // these three components even without Glint. Validate clean (the
    // base test config uses :recommended which has void-style:omit; we
    // override here to match the .gts-recommended convention since the
    // substituted <input ... /> uses self-closing form).
    const r = await validate('builtins.hbs', { 'void-style': 'off' });
    expect(
      r.errorCount,
      `expected clean validation; got: ${JSON.stringify(r.messages)}`,
    ).toBe(0);
  });

  describe('.gjs (template-imports + JavaScript)', () => {
    // .gjs goes through the same content-tag → blanker pipeline as .gts,
    // just without TS in the surrounding code. Same fixtures, same
    // assertions — confirms the file-extension matching is right.
    it('parses without transformer artifacts', async () => {
      const r = await validate('glimmer-js.gjs');
      const artifacts = r.messages.filter(
        (m) =>
          m.rule === 'parser-error' ||
          m.rule === 'element-name' ||
          m.rule === 'element-case' ||
          m.rule === 'close-order',
      );
      expect(
        artifacts,
        `transformer-artifact errors leaked: ${JSON.stringify(artifacts)}`,
      ).toHaveLength(0);
    });

    it('JS portion (imports, class body) does NOT bleed into html-validate', async () => {
      const r = await validate('glimmer-js.gjs');
      // If content-tag extraction broke, we'd see errors on `import` / `class`
      // / `const TITLE_KEY = ...` — TS-generic-style nonsense interpreted as
      // HTML.
      const jsBleed = r.messages.filter((m) =>
        /import|class\s+[A-Z]|const\s+[A-Z]/.test(m.message ?? ''),
      );
      expect(jsBleed).toHaveLength(0);
    });
  });

  describe('issue #37: SVG / MathML element-name + element-case false positives', () => {
    it('control: literal `<svg>` wrapper validates clean (foreign-body discard)', async () => {
      const r = await validate('svg-inline.gts');
      // Broad assertion — this is the control case for the whole
      // describe block, so any error (not just element-name /
      // element-case) on this fixture should fail the test loudly.
      expect(r.errorCount, JSON.stringify(r.messages)).toBe(0);
    });

    it('svg-namespace fragment in `{{#if}}` with no in-template <svg> ancestor: silenced by the canonical svg-tags / mathml-tag-names allowlist', async () => {
      const r = await validate('svg-foreign-content.gts');
      const offending = r.messages.filter(
        (m) => m.rule === 'element-name' || m.rule === 'element-case',
      );
      expect(offending).toEqual([]);
    });

    it('mathml fragment with no in-template <math> ancestor: silenced by the same allowlist', async () => {
      const r = await validate('mathml-foreign-content.gts');
      const offending = r.messages.filter(
        (m) => m.rule === 'element-name' || m.rule === 'element-case',
      );
      expect(offending).toEqual([]);
    });

    // The allowlist is *canonical case* only — typos and miscased
    // variants still fire. Locks in the case-discrimination contract
    // so we don't regress to a case-insensitive allowlist (which
    // would silence `<lineargradient>` etc. as a side effect).
    it('non-canonical case still fires: `<lineargradient>` typo, `<LinearGradient>` wrong-case, `<dIv>` miscased HTML', async () => {
      const hv = new HtmlValidate({
        root: true,
        extends: ['html-validate:recommended', 'html-validate-ember:recommended'],
        plugins: [plugin],
      });
      const cases: Array<[string, string[]]> = [
        ['<defs></defs>', []],
        ['<linearGradient></linearGradient>', []],
        ['<lineargradient></lineargradient>', ['element-name']],
        ['<LinearGradient></LinearGradient>', ['element-case', 'element-name']],
        ['<dIv></dIv>', ['element-case']],
      ];
      for (const [src, expected] of cases) {
        const r = await hv.validateString(src);
        const ids = r.results
          .flatMap((x) => x.messages)
          .map((m) => m.ruleId)
          .filter((id) => id === 'element-name' || id === 'element-case')
          .sort();
        expect(ids, `for input ${src}`).toEqual(expected.sort());
      }
    });
  });
});
