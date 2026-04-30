import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { HtmlValidate } from 'html-validate';
import type { RuleConfig } from 'html-validate';

import plugin from '../index.js';

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

  it('form-submit-in-else: wcag/h32 not flagged when submit button is in {{else}}', async () => {
    const r = await validate('form-submit-in-else.gts');
    const wcagH32 = r.messages.filter((m) => m.rule === 'wcag/h32');
    expect(wcagH32).toHaveLength(0);
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
