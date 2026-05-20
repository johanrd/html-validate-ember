import { Preprocessor } from 'content-tag';
import { DynamicValue as DynamicValueESM } from 'html-validate';
import type {
  AttributeData,
  ProcessAttributeCallback,
  ProcessElementCallback,
  Source,
  SourceHooks,
  Transformer,
} from 'html-validate';
import { createRequire } from 'node:module';

import { preprocess } from '@glimmer/syntax';

import {
  blankTemplateContent,
  blankTemplateContentMultipass,
} from './blank.js';
import { buildResolutionMaps } from './lib/resolver/build-maps.js';
import { isDynamicValuePlaceholder } from './lib/dynamic-value.js';
import { extractAttrTypeMap } from './lib/glint.js';
import { extractStringScope } from './lib/scope.js';

// Cross-realm `DynamicValue` shim.
//
// html-validate is published as a dual package (ESM + CJS) — `import`
// resolves to `dist/esm/index.js` and `require()` to `dist/cjs/index.js`.
// Each build defines its OWN `class DynamicValue { ... }`. When our
// plugin runs in a context that loaded html-validate through the
// opposite build (e.g. the html-validate VS Code extension loads
// html-validate as CJS via `require()`, but our plugin imports it as
// ESM), `text instanceof DynamicValue` checks on the host side return
// false against our ESM-class instance — so `TextNode.isDynamic` is
// false, `classifyNodeText` returns `EMPTY_TEXT` instead of
// `DYNAMIC_TEXT`, and rules like `empty-heading` / `text-content`
// FP-fire on dynamic content the user CAN'T see is empty.
//
// Fix: load BOTH DynamicValue classes (ESM + CJS), and define our own
// marker class. Patch `Symbol.hasInstance` on each html-validate
// class so it returns true for either:
//   - The original prototype-based check (genuine DynamicValue
//     instances from that realm), OR
//   - Any object carrying our marker symbol.
//
// Then the host's `instanceof DynamicValue` check passes regardless of
// which realm loaded html-validate. Trade-off: a one-time mutation of
// the host's DynamicValue class (only adds tolerance, doesn't change
// existing behavior). No runtime cost beyond the patch.
const require = createRequire(import.meta.url);
const { DynamicValue: DynamicValueCJS } = require('html-validate') as {
  DynamicValue: typeof DynamicValueESM;
};
const HVE_DYNAMIC = Symbol.for('html-validate-ember.DynamicValue');

class DynamicValue {
  expr: string;
  [HVE_DYNAMIC] = true as const;
  constructor(expr: string) {
    this.expr = expr;
  }
  toString(): string {
    return this.expr;
  }
}

for (const cls of new Set<typeof DynamicValueESM>([DynamicValueESM, DynamicValueCJS])) {
  Object.defineProperty(cls, Symbol.hasInstance, {
    configurable: true,
    value(instance: unknown) {
      if (
        instance &&
        typeof instance === 'object' &&
        (instance as Record<symbol, unknown>)[HVE_DYNAMIC]
      ) {
        return true;
      }
      return cls.prototype.isPrototypeOf(instance as object);
    },
  });
}

const preprocessor = new Preprocessor();

// Side-channel from the transformer to `dedupeMultipassReport`. For
// each .gts/.gjs/.hbs file, holds the file-line ranges of templates
// that multipass actually branched on (i.e., yielded >1 `Source`). The
// dedupe step uses these ranges to drop reports from rules that don't
// compose cleanly with branch-by-branch validation — see
// `MULTIPASS_INCOMPATIBLE_RULES` in `lib/multipass-dedupe.ts` —
// scoped to the branched template only, so multi-template files don't
// over-suppress.
//
// Key matches `Source.filename`, which html-validate reflects
// unchanged as `Result.filePath` in the report it builds. Not safe
// for re-entrant validation: the map is module-global and cleared
// imperatively by the transformer (on entry) and by the dedupe (on
// completion). A single-process / single-thread harness is fine; an
// embedder that runs concurrent `validateFile` calls would need to
// rework this.
export const __multipassBranchedRanges = new Map<string, Array<[number, number]>>();

// Build an inline `<!--html-validate-disable …-->` directive to prepend
// to a multipass branched Source. The only rule passed in today is
// `no-unused-disable` — directives load-bearing in one branch
// combination would otherwise be reported "unused" in another. The
// post-report dedupe in `lib/multipass-dedupe.ts` only runs for callers
// that route through `dedupeMultipassReport` (the bundled CLI and
// tests; NOT the html-validate VS Code extension, NOT the standalone
// `html-validate` CLI), so we mirror it inline. The rule name must
// stay in sync with `MULTIPASS_INCOMPATIBLE_RULES` in
// `lib/multipass-dedupe.ts`.
//
// Structural-rule suppressions (wcag/h32, wcag/h63, wcag/h67, wcag/h71,
// element-permitted-content, element-permitted-parent,
// element-required-content) are no longer routed through this directive
// — they land as per-element `el.disableRules(...)` calls via the
// `processElement` hook (see `BlankResult.disablePerElement`).
//
// Bracket-less form is the shortest valid spelling per html-validate's
// `MATCH_DIRECTIVE` regex; no newline so we can compensate with a
// single column-shift on the Source.
function buildDisableDirective(rules: ReadonlyArray<string>): string {
  if (rules.length === 0) return '';
  // html-validate's directive grammar requires COMMA-separated rule
  // names. Space-separated silently disables only the first rule —
  // masking suppression in branched templates where the directive
  // carries both `no-unused-disable` and a structural-yield rule.
  return `<!--html-validate-disable ${rules.join(', ')}-->`;
}

function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function makeHooks(
  dynamicSet: ReadonlySet<number>,
  attrInjections: ReadonlyMap<number, ReadonlyArray<{ attr: string; value: string | null }>>,
  disablePerElement: ReadonlyMap<number, ReadonlySet<string>>,
  startOffset: number,
): SourceHooks {
  const processAttribute: ProcessAttributeCallback = (attr: AttributeData) => {
    // Bare-mustache attribute values (`id={{x}}`) reach this hook as
    // whitespace-only strings. Two upstream sources produce them:
    //   1. `blank.ts` blanks each mustache span in place — the
    //      resulting whitespace is the same length as the original
    //      mustache (variable, can be much longer than the sentinel).
    //   2. Explicit injections by `blank.ts` and `component-attrs.ts`
    //      use the literal `DYNAMIC_VALUE_PLACEHOLDER` from
    //      `lib/dynamic-value.ts` (a fixed-length 3-space string at
    //      the time of writing).
    // `isDynamicValuePlaceholder` accepts both: any whitespace-only
    // string of length >= the sentinel's length. This is intentional —
    // we want the same DynamicValue conversion for either source so
    // rules see "attribute present, value unknowable" regardless of
    // how the placeholder was produced.
    if (isDynamicValuePlaceholder(attr.value)) {
      return [{ ...attr, value: new DynamicValue('') as unknown as DynamicValueESM }];
    }
    return [attr];
  };

  const processElement: ProcessElementCallback = function (el) {
    const location = (el as unknown as { location?: { offset?: number } }).location;
    if (!location || typeof location.offset !== 'number') {
      return;
    }
    // html-validate's location.offset for an element points to the
    // tag-name byte (one past `<`), while Glimmer's getStart() points
    // to the `<` itself. Adjust by 1.
    const templateRelativeOffset = location.offset - startOffset - 1;
    if (dynamicSet.has(templateRelativeOffset)) {
      (el as unknown as { appendText(value: unknown, location: unknown): void }).appendText(
        new DynamicValue(''),
        location,
      );
    }
    // Apply attribute injections registered by blank.ts. Each entry
    // names an attr and either a literal value or null (= DynamicValue
    // placeholder). Attribute-already-present is a no-op so consumer-
    // written values always win (the blanker's per-attr precision
    // already gates which attrs get registered, but defensive double-
    // check guards races where a substitution path didn't propagate).
    const injections = attrInjections.get(templateRelativeOffset);
    if (injections && injections.length > 0) {
      const elWithAttrs = el as unknown as {
        tagName?: string;
        hasAttribute(name: string): boolean;
        setAttribute(
          name: string,
          value: unknown,
          keyLocation: unknown,
          valueLocation: unknown,
        ): void;
      };
      for (const { attr, value } of injections) {
        if (elWithAttrs.hasAttribute(attr)) continue;
        const injected = value === null ? new DynamicValue('') : value;
        elWithAttrs.setAttribute(attr, injected, location, location);
      }
    }
    // Per-element rule disables. Registered by blank.ts when a
    // specific element triggers a Glimmer-opacity FP class (e.g.,
    // `<table>` with a cell-loop {{#each}}, `<form>` with a
    // yield-bearing body, `<img>` with dynamic title, …). Rule
    // listeners (`element:ready`, `tag:end`, `dom:ready`, …) check
    // `ruleEnabled(...)` inside their `report()` paths, so this
    // disable lands before emission regardless of when the rule
    // fires for this element.
    const disables = disablePerElement.get(templateRelativeOffset);
    if (disables && disables.size > 0) {
      (el as unknown as { disableRules(rules: ReadonlyArray<string>): void }).disableRules([
        ...disables,
      ]);
    }
  };

  return { processAttribute, processElement };
}

function* transformGlimmer(source: Source): Generator<Source, void, unknown> {
  const data = source.data;
  const originalData = source.originalData ?? data;
  const filename = source.filename ?? '';

  // Clear any stale state left by a previous validation of this file
  // whose dedupe step never ran (e.g., the file was clean and `run.ts`
  // skipped dedupe, or an embedder consumes reports without dedupe).
  // Long-running processes (editor LSP) shouldn't accumulate ranges.
  __multipassBranchedRanges.delete(filename);

  // Classic .hbs template: the file IS the template content. No JS
  // portion, no `<template>` extraction, no Glint integration (Glint's
  // .hbs flow uses Ember's container resolver — different machinery).
  // Components blank transparently (open/close tags removed; children
  // float to the actual parent), with built-in <Input>/<Textarea>/<LinkTo>
  // mapping to native tags. Static-text resolution covers t-helper /
  // if-helper. No top-level scope (no JS).
  if (filename.endsWith('.hbs')) {
    // Classic-Ember by-name component resolution: parse the template
    // once to walk PascalCase tags, look each one up in node_modules
    // against the canonical addon component-template paths, and feed
    // the resulting tag/attr maps to the blanker. Lets `<EsCard>` /
    // `<HdsCard>` / etc. substitute to their actual rendered tag
    // (`<li>`, `<div>`, …) instead of transparent-blanking, which
    // fixes a major class of `element-permitted-content` FPs in
    // classic Ember apps. Glint isn't involved — `.hbs` doesn't go
    // through TS.
    let classicTagMap: Map<string, string> | null = null;
    let classicAttrMap: Parameters<typeof blankTemplateContent>[4] | null = null;
    try {
      const ast = preprocess(data, { mode: 'codemod' });
      const maps = buildResolutionMaps(filename, ast);
      classicTagMap = maps.componentTagMap;
      classicAttrMap = maps.componentAttrMap;
    } catch {
      // Parse failure here is non-fatal — `blankTemplateContent`
      // re-parses and reports the error. Drop the maps and continue.
    }
    const result = blankTemplateContent(data, undefined, undefined, classicTagMap, classicAttrMap);
    if (result.error) {
      process.stderr.write(
        `[html-validate-ember] glimmer parse failure on ${filename}: ${result.error.message}\n`,
      );
    }
    if (result.content.length !== data.length) {
      process.stderr.write(
        `[html-validate-ember] BUG: blanked length ${result.content.length} != original ${data.length}\n`,
      );
    }
    // .hbs files never go through the multipass branched path, so
    // there's no `no-unused-disable` directive to inject and no
    // structural-rule file-level disables (those are all per-element
    // now). The Source's data starts at offset 0 / column 1.
    yield {
      data: result.content,
      filename,
      line: 1,
      column: 1,
      offset: 0,
      originalData,
      hooks: makeHooks(
        new Set(result.dynamicContentOffsets ?? []),
        result.attrInjections ?? new Map(),
        result.disablePerElement ?? new Map(),
        0,
      ),
    };
    return;
  }

  // .gts / .gjs: extract `<template>` blocks via content-tag, blank
  // each one, optionally enrich with Glint type info.
  const scope = extractStringScope(data, filename);
  let glintTypeMap = null;
  let glintComponentTagMap: Map<string, string> | null = null;
  let glintComponentAttrMap: Parameters<typeof blankTemplateContent>[4] | null = null;
  // Glint type extraction is opt-OUT: it's worthwhile in real-world
  // use (it lifts the resolver from "what's imported" to "what TS
  // says about each invocation", catching @arg literals, Signature
  // ['Element'] declarations, polymorphic-tag union picks, etc.),
  // and `extractAttrTypeMap` handles a missing `@glint/ember-tsc`
  // install gracefully by returning null and letting the canonical-
  // resolver fallback below take over. Set `HVE_GLINT=0` (or pass
  // `--no-glint` to the bundled runners) to disable.
  //
  // When Glint extraction runs, `extractAttrTypeMap` returns the same
  // component-tag + attr maps the canonical resolver alone would
  // produce, PLUS attrTypeMap (string-literal-union narrowing for
  // mustache attr values). When it's disabled (or unavailable), we
  // still need the tag/attr maps so e.g. `<HdsCard>` substitutes to
  // `<li>` and `<AddResource>` substitutes to `<dialog id="…" …>` —
  // without them, custom elements stay as-is in the blanked output
  // and rules like `no-dup-id`, `element-permitted-content`,
  // `prefer-tbody` etc. can't see the rendered DOM. The per-template
  // `buildResolutionMaps` call inside the loop below covers that
  // fallback path.
  if (process.env['HVE_GLINT'] !== '0') {
    try {
      const result = extractAttrTypeMap(filename, data);
      if (result) {
        glintTypeMap = result.attrTypeMap;
        glintComponentTagMap = result.componentTagMap;
        glintComponentAttrMap = result.componentAttrMap;
      }
    } catch (err) {
      process.stderr.write(
        `[html-validate-ember] glint type extraction failed for ${filename}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }
  let parsed: ReturnType<Preprocessor['parse']>;
  try {
    parsed = preprocessor.parse(data, { filename });
  } catch (err) {
    process.stderr.write(
      `[html-validate-ember] parse failure on ${filename}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return;
  }
  // Multipass branch validation: enumerate {{#if}}/{{else}} branch
  // combinations and yield one Source per combination so each is
  // independently validated. Errors in unselected branches surface;
  // identical blanked outputs are deduped before validation.
  //
  // Trade-off: an error stable across branches (e.g., a real misnesting
  // OUTSIDE the if/else) gets reported once per pass. The bundled
  // `validate-gts` CLI dedupes by (line, column, ruleId, message)
  // before printing. Direct html-validate consumers (the VS Code
  // extension, the `html-validate` CLI used standalone) don't dedupe;
  // set `HVE_MAX_CONDITIONAL_BRANCHES=0` to fall back to the
  // single-branch form-submit-aware heuristic if duplicates are
  // annoying.
  //
  // For the `no-unused-disable` catch-22 (a directive load-bearing in
  // one pass looks unused in another), we DON'T rely on
  // `dedupeMultipassReport` alone — the dedupe lives outside
  // html-validate and direct consumers don't run it. Instead, we
  // prepend an inline `<!--html-validate-disable no-unused-disable-->`
  // directive to each branched Source's data, and shift the Source's
  // `offset`/`column` by the directive's length so the original
  // content's positions still map back to the original file. That
  // makes the rule effectively off inside any branched template
  // regardless of who calls html-validate. Trade-off: a *genuinely*
  // unused directive inside a branched template stops firing too. We
  // accept that: it's bounded (only branched templates) and chosen
  // over the FP catch-22 that has no escape hatch for users. Keep in
  // sync with `MULTIPASS_INCOMPATIBLE_RULES` in `lib/multipass-dedupe.ts`.
  for (const tpl of parsed) {
    if (tpl.tagName !== 'template') {
      continue;
    }
    const startOffset = tpl.contentRange.startChar;
    const { line, column } = offsetToLineCol(data, startOffset);
    // No Glint info available → run the canonical resolver alone for
    // this template block. Mirrors the .hbs path: walk PascalCase
    // invocations, resolve via imports + addon by-name, project the
    // resolved component's root tag + static attrs into the blanker.
    // Without this, editors that don't set `HVE_GLINT=1` (e.g. the
    // VS Code html-validate extension) blank-out `<MyComponent>` as
    // a custom element and downstream rules can't see the rendered
    // tag — observably, no-dup-id / element-permitted-content /
    // prefer-tbody all stop firing on shape that the CLI catches.
    let tagMap = glintComponentTagMap;
    let attrMap = glintComponentAttrMap;
    if (!tagMap) {
      try {
        const ast = preprocess(tpl.contents, { mode: 'codemod' });
        const maps = buildResolutionMaps(filename, ast);
        tagMap = maps.componentTagMap;
        attrMap = maps.componentAttrMap;
      } catch {
        // Parse failure here is non-fatal — `blankTemplateContent`
        // re-parses and reports the error. Drop the maps and continue.
      }
    }
    const results = blankTemplateContentMultipass(
      tpl.contents,
      scope,
      glintTypeMap,
      tagMap,
      attrMap,
    );
    const branched = results.length > 1;
    if (branched) {
      // Record the file-line range covered by this template's content
      // so the dedupe can scope its rule-suppression to just this
      // template (not the whole file). Multi-template files keep
      // non-branched templates' diagnostics intact.
      const endLine = offsetToLineCol(data, tpl.contentRange.endChar).line;
      const ranges = __multipassBranchedRanges.get(filename) ?? [];
      ranges.push([line, endLine]);
      __multipassBranchedRanges.set(filename, ranges);
    }
    for (const result of results) {
      if (result.error) {
        process.stderr.write(`[html-validate-ember] glimmer parse failure: ${result.error.message}\n`);
      }
      if (result.content.length !== tpl.contents.length) {
        process.stderr.write(
          `[html-validate-ember] BUG: blanked length ${result.content.length} != original ${tpl.contents.length}\n`,
        );
      }
      // The only rule the prefix directive carries today is
      // `no-unused-disable` for branched (multipass) sources;
      // structural suppressions live in `result.disablePerElement`
      // and land via `processElement → el.disableRules` instead.
      const prefix = branched ? buildDisableDirective(['no-unused-disable']) : '';
      const sourceData = prefix + result.content;
      const sourceOffset = startOffset - prefix.length;
      const sourceColumn = column - prefix.length;
      // Elements whose only Glimmer source content was mustaches will look
      // empty after blanking. Hook them and append a DynamicValue placeholder
      // so html-validate's empty-heading / text-content rules see "has content,
      // unknowable" rather than truly empty.
      yield {
        data: sourceData,
        filename,
        line,
        column: sourceColumn,
        offset: sourceOffset,
        originalData,
        hooks: makeHooks(
          new Set(result.dynamicContentOffsets ?? []),
          result.attrInjections ?? new Map(),
          result.disablePerElement ?? new Map(),
          startOffset,
        ),
      };
    }
  }
}

// html-validate transformers carry an `api` version marker as a static
// property. The Transformer type is a callable interface and our
// generator function shape doesn't exactly match its signature, so cast
// through `unknown`.
const transformer = transformGlimmer as unknown as Transformer & { api: number };
transformer.api = 1;

export default transformer;
