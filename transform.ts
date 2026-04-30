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

import { blankTemplateContent } from './blank.js';
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

function makeHooks(dynamicSet: ReadonlySet<number>, startOffset: number): SourceHooks {
  const processAttribute: ProcessAttributeCallback = (attr: AttributeData) => {
    // Bare-mustache attribute values (`id={{x}}`) are emitted as
    // `id="<spaces>"` (see blank.ts). Detect that pattern and replace
    // the value with a DynamicValue so rules see "attribute present,
    // value unknowable". The minimum length 3 matches the shortest
    // possible original mustache `{{x}}` (5 chars → `"<3 spaces>"`).
    if (
      typeof attr.value === 'string' &&
      attr.value.length >= 3 &&
      /^\s+$/u.test(attr.value)
    ) {
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
  };

  return { processAttribute, processElement };
}

function* transformGlimmer(source: Source): Generator<Source, void, unknown> {
  const data = source.data;
  const originalData = source.originalData ?? data;
  const filename = source.filename ?? '';

  // Classic .hbs template: the file IS the template content. No JS
  // portion, no `<template>` extraction, no Glint integration (Glint's
  // .hbs flow uses Ember's container resolver — different machinery).
  // Components blank transparently (open/close tags removed; children
  // float to the actual parent), with built-in <Input>/<Textarea>/<LinkTo>
  // mapping to native tags. Static-text resolution covers t-helper /
  // if-helper. No top-level scope (no JS).
  if (filename.endsWith('.hbs')) {
    const result = blankTemplateContent(data);
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
    yield {
      data: result.content,
      filename,
      line: 1,
      column: 1,
      offset: 0,
      originalData,
      hooks: makeHooks(new Set(result.dynamicContentOffsets ?? []), 0),
    };
    return;
  }

  // .gts / .gjs: extract `<template>` blocks via content-tag, blank
  // each one, optionally enrich with Glint type info.
  const scope = extractStringScope(data);
  let glintTypeMap = null;
  let glintComponentTagMap = null;
  let glintComponentAttrMap = null;
  // Glint type extraction is opt-in. It adds ~24× runtime overhead (TS
  // program rebuild + rewriteModule per file) for narrow real-world yield —
  // most Ember codebases don't type @args as string-literal unions or
  // declare Signature['Element'], so Glint mostly returns generic types.
  // Set HVE_GLINT=1 (or pass --glint to the runners) to enable when you
  // know your components have the typing discipline to benefit.
  if (process.env['HVE_GLINT']) {
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
  for (const tpl of parsed) {
    if (tpl.tagName !== 'template') {
      continue;
    }
    const startOffset = tpl.contentRange.startChar;
    const { line, column } = offsetToLineCol(data, startOffset);
    const result = blankTemplateContent(
      tpl.contents,
      scope,
      glintTypeMap,
      glintComponentTagMap,
      glintComponentAttrMap,
    );
    if (result.error) {
      process.stderr.write(`[html-validate-ember] glimmer parse failure: ${result.error.message}\n`);
    }
    if (result.content.length !== tpl.contents.length) {
      process.stderr.write(
        `[html-validate-ember] BUG: blanked length ${result.content.length} != original ${tpl.contents.length}\n`,
      );
    }
    // Elements whose only Glimmer source content was mustaches will look
    // empty after blanking. Hook them and append a DynamicValue placeholder
    // so html-validate's empty-heading / text-content rules see "has content,
    // unknowable" rather than truly empty.
    yield {
      data: result.content,
      filename,
      line,
      column,
      offset: startOffset,
      originalData,
      hooks: makeHooks(new Set(result.dynamicContentOffsets ?? []), startOffset),
    };
  }
}

// html-validate transformers carry an `api` version marker as a static
// property. The Transformer type is a callable interface and our
// generator function shape doesn't exactly match its signature, so cast
// through `unknown`.
const transformer = transformGlimmer as unknown as Transformer & { api: number };
transformer.api = 1;

export default transformer;
