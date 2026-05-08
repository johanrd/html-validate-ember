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
