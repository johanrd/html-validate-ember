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
    // Trade-off: html-validate v10.13.1 schema doesn't include popover yet,
    // so the BAD_POPOVER='bogus' const doesn't fire attribute-allowed-values.
    // Instead, validate the const did NOT cause spurious errors on the
    // valid resolutions (POPOVER_MODE='auto', FORM_METHOD='post').
    const popoverErrors = r.messages.filter((m) => m.rule === 'attribute-allowed-values');
    expect(popoverErrors).toHaveLength(0);
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

  it('block-param-types: multi-param `as |a: A, b: B|` parses and the body validates', async () => {
    // Glimmer's parser rejects multi-param block-params with type
    // annotations (and the commas between them). The transformer
    // pre-strips both before Glimmer sees the source so the template
    // parses normally. We verify by asserting that a body-level error
    // (duplicate id `dup`) fires — proving the body was actually
    // walked, not silently skipped.
    const r = await validate('block-param-types.gts');
    const dupIds = r.messages.filter((m) => m.rule === 'no-dup-id');
    expect(
      dupIds,
      `expected no-dup-id from body of multi-param block; got: ${JSON.stringify(r.messages)}`,
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
});
