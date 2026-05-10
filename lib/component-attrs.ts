// Extract attribute info from a component's "splatted root" — the element
// in the component's `<template>` that has `...attributes` (i.e. the
// element that gets the parent invocation's attributes spread onto it; the
// rendered root from the parent's perspective). When the parent substitutes
// <MyComp /> to a native tag (via Glint's Signature['Element'] resolution),
// this attribute info is propagated to the substituted output so
// html-validate sees the runtime-provided attributes as present.
//
// Where this info lands at the consumer call site is controlled by
// `blank.ts`:
//   - Block-form (`<MyComp>...</MyComp>`): `tryInjectComponentAttrs`
//     injects each attr into a Glimmer-only blank slot in the open tag.
//   - Self-closing void native (e.g. component → `<input>`):
//     `substituteSelfClosingVoidComponent` does an in-place tag rename;
//     `tryInjectInputType` injects `type` for `<input>`. Other attrs are
//     not currently embedded.
//   - Self-closing non-void native (e.g. component → `<iframe>`):
//     `substituteSelfClosingComponent` rewrites the whole element span
//     to `<RESOLVED ...attrs></RESOLVED>` and embeds every recorded attr.
//
// Two value forms are recorded:
//   - Literal `TextNode` values are recorded verbatim — html-validate then
//     sees the actual value (e.g. `type='range'` enables enum checks).
//   - Bare-mustache (`title={{@label}}`) and concat-mustache
//     (`class='prefix-{{x}}'`) values are recorded as the
//     `DYNAMIC_VALUE_PLACEHOLDER` constant from `lib/dynamic-value.ts`.
//     The blanker injects this placeholder at the consumer's call
//     site, and `processAttribute` (transform.ts) recognizes it via
//     `isDynamicValuePlaceholder` and converts to a DynamicValue —
//     html-validate sees "attribute present, value unknowable", which
//     is enough for `element-required-attributes` and similar
//     required-attribute rules.
//
// Example: component template
//
//   <template>
//     <input ...attributes type='range' min='0' max='100' value={{@v}} />
//   </template>
//
// `extractSplattedRootFromTemplate` (called by `getSplattedRootsForFile`)
// returns:
//
//   { tag: 'input', attrs: { type: 'range', min: '0', max: '100',
//                            value: DYNAMIC_VALUE_PLACEHOLDER } }
//
// Limitations:
//   - Glimmer-only attrs (`@arg`, `...attributes`, modifiers) are skipped.
//   - When no element has `...attributes`, falls back to the first
//     top-level element (which is the rendered root for most TOC and
//     class-component patterns).
//   - Does not resolve nested `{{#if}}` branches; if the splatted root
//     is conditional, picks the first one it finds.

import { Preprocessor } from 'content-tag';
import { preprocess, traverse } from '@glimmer/syntax';
import type { AST } from '@glimmer/syntax';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type * as TS from 'typescript';

const localRequire = createRequire(import.meta.url);

import type { ComponentAttrs } from './builtin-components.js';
import { DYNAMIC_VALUE_PLACEHOLDER } from './dynamic-value.js';

const preprocessor = new Preprocessor();

// Per-source-file cache: filename → splatted-root info (or null).
// Process-lifetime: never expires within a process. Fine for the CLI
// (one process per sweep) and for typical IDE re-validation (cache hit
// across rapid edits to the consumer file). A long-running language
// server that wants to pick up edits to the *component* file (the one
// whose splatted root we cached) would need to invalidate on file
// change — `_clearCache` is exposed for tests; a public invalidator
// can be added when that use case lands.
const cache = new Map<string, ComponentAttrs[]>();

function isGlimmerOnlyAttr(name: string | undefined): boolean {
  if (!name) return false;
  return name.startsWith('@') || name === '...attributes' || name === 'as' || name.startsWith('|');
}

export function elementHasSplat(node: AST.ElementNode): boolean {
  for (const attr of node.attributes ?? []) {
    if (attr.name === '...attributes') return true;
  }
  return false;
}

export function literalAttrs(node: AST.ElementNode): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of node.attributes ?? []) {
    if (isGlimmerOnlyAttr(attr.name)) continue;
    if (attr.value.type === 'TextNode' && typeof attr.value.chars === 'string') {
      attrs[attr.name] = attr.value.chars;
    } else if (
      attr.value.type === 'MustacheStatement' ||
      attr.value.type === 'ConcatStatement'
    ) {
      // Bare-mustache (`title={{@label}}`) and concat-mustache
      // (`class='prefix-{{x}}'`) values are computed at runtime. We can't
      // anticipate the literal, but we DO know the attribute is present —
      // so record it with the shared `DYNAMIC_VALUE_PLACEHOLDER`
      // sentinel. The blanker injects this placeholder into a
      // Glimmer-only blank slot at the consumer's call site, and
      // html-validate's `processAttribute` hook recognizes it via
      // `isDynamicValuePlaceholder` and converts to DynamicValue.
      // This rescues required-attribute rules
      // (e.g. `<iframe title={{@label}}>`-style components surfacing
      // `element-required-attributes` on the wrapped iframe).
      attrs[attr.name] = DYNAMIC_VALUE_PLACEHOLDER;
    }
  }
  return attrs;
}

// `(element X)` polymorphic-tag detection.
//
// HDS-style polymorphic-tag components (HdsText, HdsTextBody, …) use
// the Glimmer `(element ...)` helper to render whatever tag the
// `<expr>` argument resolves to:
//
//   <template>
//     {{#let (element this.componentTag) as |Tag|}}
//       <Tag ...attributes>{{yield}}</Tag>
//     {{/let}}
//   </template>
//
// Glint's Element-type union for these (`HTMLSpanElement |
// HTMLHeadingElement | …`) doesn't propagate the runtime tag —
// our static analysis arbitrarily picks the first match (`<h1>`)
// when the actual runtime tag is `<li>` (when consumer passes
// `@tag="li"` through).
//
// This helper detects the primitive and classifies the source
// expression:
//   - literal:   `(element 'span')`           — runtime tag is fixed
//   - arg:       `(element @argName)`         — pass-through; caller
//                                                resolves at wrapper
//   - this-prop: `(element this.propName)`    — class property; caller
//                                                resolves via class
//                                                walk
// The discriminated union lets the leaf-fallback in `glint.ts` decide
// whether to surface a concrete tag, mark transparent, or trace the
// wrapper chain.
export type PolymorphicTagSource =
  | { kind: 'literal'; value: string }
  | { kind: 'arg'; argName: string }
  | { kind: 'this-prop'; propName: string };

export function detectPolymorphicTag(ast: AST.Template): PolymorphicTagSource | null {
  let result: PolymorphicTagSource | null = null;
  function visit(stmts: ReadonlyArray<AST.Statement | AST.TopLevelStatement>): void {
    for (const stmt of stmts) {
      if (result !== null) return;
      if (stmt.type === 'BlockStatement') {
        const isLet =
          stmt.path.type === 'PathExpression' && stmt.path.original === 'let';
        if (isLet) {
          // Look for `(element <expr>)` as the let's first param.
          const param = stmt.params[0];
          if (
            param &&
            param.type === 'SubExpression' &&
            param.path.type === 'PathExpression' &&
            param.path.original === 'element'
          ) {
            const expr = param.params[0];
            if (expr) {
              result = classifyTagExpression(expr);
              if (result) return;
            }
          }
        }
        visit(stmt.program.body);
        if (stmt.inverse) visit(stmt.inverse.body);
        continue;
      }
      if (stmt.type === 'ElementNode') {
        visit(stmt.children);
      }
    }
  }
  visit(ast.body);
  return result;
}

function classifyTagExpression(expr: AST.Expression): PolymorphicTagSource | null {
  if (expr.type === 'StringLiteral' && typeof expr.value === 'string') {
    return { kind: 'literal', value: expr.value };
  }
  if (expr.type === 'PathExpression') {
    if (expr.head.type === 'AtHead') {
      // Glimmer's `AtHead.name` is `@argName` (with the leading
      // `@`). Strip it for caller consistency — the caller compares
      // against attr-name keys which are also stored with `@`-
      // prefix in Glimmer ASTs but matched without it semantically.
      const raw = expr.head.name;
      const argName = raw.startsWith('@') ? raw.slice(1) : raw;
      return { kind: 'arg', argName };
    }
    if (expr.head.type === 'ThisHead' && expr.tail.length === 1) {
      return { kind: 'this-prop', propName: expr.tail[0]! };
    }
  }
  return null;
}

// Resolved polymorphic-tag info, propagated up the wrapper chain.
//   - { tag }                  — runtime tag is fixed (literal or
//                                fully traced through @arg).
//   - { polymorphicOnArg }     — runtime tag is whatever the
//                                consumer passes for this arg.
//   - null                     — couldn't determine (e.g.
//                                this.prop without a class walk,
//                                or chain hit an untraceable hop).
export type ResolvedPolymorphicTag =
  | { kind: 'tag'; tag: string }
  | { kind: 'arg'; argName: string };

// Read a literal `@argName="X"` value from `node`, or null if the
// arg isn't present, isn't a literal, or doesn't resolve.
function readArgLiteral(node: AST.ElementNode, argName: string): string | null {
  for (const attr of node.attributes ?? []) {
    if (attr.name !== `@${argName}`) continue;
    if (attr.value.type !== 'TextNode') return null;
    if (typeof attr.value.chars !== 'string') return null;
    return attr.value.chars;
  }
  return null;
}

// Read a `@argName={{@otherArg}}` arg value, or null.
function readArgPassthrough(node: AST.ElementNode, argName: string): string | null {
  for (const attr of node.attributes ?? []) {
    if (attr.name !== `@${argName}`) continue;
    if (attr.value.type !== 'MustacheStatement') return null;
    const path = attr.value.path;
    if (path.type !== 'PathExpression') return null;
    if (path.head.type !== 'AtHead') return null;
    const raw = path.head.name;
    return raw.startsWith('@') ? raw.slice(1) : raw;
  }
  return null;
}

// Resolve the polymorphic-tag info for a `.gts` source file. Walks
// the addon's template chain through PascalCase wrappers, propagating
// the `(element ...)` helper's source through `@arg` literal /
// pass-through bindings.
//
// Examples (HDS):
//   - hds/text/index.gts
//       template uses `(element this.componentTag)`. componentTag is
//       a class getter — we don't walk class properties (deferred).
//       Result: null.
//   - hds/text/body.gts
//       template root: `<HdsText @tag={{@tag}} ...>`. HdsText is
//       polymorphic, source = this.componentTag (null). Result: null.
//
//   But:
//   - hds/dropdown/list-item/title.gts
//       template root: `<HdsTextBody @tag="li" ...>`. HdsTextBody is
//       polymorphic-on-@tag. Literal value 'li' propagates upward.
//       Result: { kind: 'tag', tag: 'li' }.
//
// Cycle guard via `visited` set; depth-limited to avoid runaway
// recursion on pathological inputs.
const polymorphicCache = new Map<string, ResolvedPolymorphicTag | null>();

export function getPolymorphicResolvedTag(filename: string): ResolvedPolymorphicTag | null {
  return getPolymorphicResolvedTagInner(filename, new Set(), 0);
}

function getPolymorphicResolvedTagInner(
  filename: string,
  visited: Set<string>,
  depth: number,
): ResolvedPolymorphicTag | null {
  if (depth > 10) return null;
  if (visited.has(filename)) return null;
  visited.add(filename);

  const cached = polymorphicCache.get(filename);
  if (cached !== undefined) return cached;

  // Try `.gts` source first (when the addon ships it, like HDS).
  // Fall back to `.js` (the v2-addon-spec shipping mode), which
  // preserves the template string inline as a `precompileTemplate(
  // "CONTENT", ...)` call — fully analyzable, even though the
  // addon doesn't publish `.gts` source. Same Glimmer AST either
  // way; the chain trace runs identically once we have the
  // template string.
  const templateContent = extractTemplateContent(filename);
  if (templateContent === null) {
    polymorphicCache.set(filename, null);
    return null;
  }
  let ast: AST.Template;
  try {
    ast = preprocess(templateContent);
  } catch {
    polymorphicCache.set(filename, null);
    return null;
  }

  // Case 1: this template directly uses `(element ...)`.
  const direct = detectPolymorphicTag(ast);
  if (direct) {
    if (direct.kind === 'literal') {
      const result = { kind: 'tag' as const, tag: direct.value };
      polymorphicCache.set(filename, result);
      return result;
    }
    if (direct.kind === 'arg') {
      const result = { kind: 'arg' as const, argName: direct.argName };
      polymorphicCache.set(filename, result);
      return result;
    }
    // this-prop: walk the class for the named getter. The HDS
    // convention is a getter that returns `this.args.<argName>` with
    // a string-literal default, e.g.
    //   get componentTag(): HdsTextTags {
    //     const { tag = 'span' } = this.args;
    //     return tag;
    //   }
    // → polymorphic-on-`@tag` with default 'span'. When the consumer
    // doesn't pass `@tag`, the runtime tag is the default; when it
    // passes `@tag="X"`, the runtime tag is X.
    // Read the file's whole source for the class-getter walk
    // (`extractTemplateContent` only returned the template string).
    let source: string;
    try {
      source = fs.readFileSync(filename, 'utf8');
    } catch {
      polymorphicCache.set(filename, null);
      return null;
    }
    const propResolution = resolveThisPropPolymorphic(filename, source, direct.propName);
    if (propResolution) {
      polymorphicCache.set(filename, propResolution);
      return propResolution;
    }
    polymorphicCache.set(filename, null);
    return null;
  }

  // Case 2: template root is a non-native invocation that may itself
  // be polymorphic. Walk one level into it.
  const root = findSplattedRoot(ast);
  if (!root) {
    polymorphicCache.set(filename, null);
    return null;
  }
  if (isNativeTagLocal(root.tag)) {
    polymorphicCache.set(filename, null);
    return null;
  }
  if (root.tag.includes('.') || root.tag.startsWith(':')) {
    polymorphicCache.set(filename, null);
    return null;
  }
  const importPath = resolveLocalImport(filename, root.tag);
  if (!importPath) {
    polymorphicCache.set(filename, null);
    return null;
  }
  const inner = getPolymorphicResolvedTagInner(importPath, visited, depth + 1);
  if (!inner) {
    polymorphicCache.set(filename, null);
    return null;
  }
  if (inner.kind === 'tag') {
    polymorphicCache.set(filename, inner);
    return inner;
  }
  // inner.kind === 'arg' — the inner component is polymorphic on this
  // arg; check our root invocation's `@argName=` for propagation.
  const literal = readArgLiteral(root, inner.argName);
  if (literal !== null) {
    const result = { kind: 'tag' as const, tag: literal };
    polymorphicCache.set(filename, result);
    return result;
  }
  const passthrough = readArgPassthrough(root, inner.argName);
  if (passthrough !== null) {
    const result = { kind: 'arg' as const, argName: passthrough };
    polymorphicCache.set(filename, result);
    return result;
  }
  // Arg is absent or unrecognized — give up.
  polymorphicCache.set(filename, null);
  return null;
}

// Read a Glimmer template's content from `filename`. Handles three
// shipping modes that real addons use:
//
//   - `.gts` / `.gjs` source: content-tag preprocesses to extract
//     the inner content from `<template>...</template>` blocks.
//     Used when an addon (or in-project component) ships source
//     templates. HDS does this; v2-addon-spec says it's optional.
//
//   - `.js` (compiled output): the template content is preserved as
//     a string literal in the first argument of either:
//       * `precompileTemplate("CONTENT", { ... })` — the current
//         (Ember 5.x) shape; HDS's `dist/components/X.js` uses this.
//       * `template("CONTENT", { ... })` — the new shape introduced
//         by emberjs/rfcs#0931 (`@ember/template-compiler`), to
//         replace `precompileTemplate` for new authoring.
//     We match either shape with a regex over the source. Quoted
//     using `"`, `'`, or backticks. JSON.parse handles `"..."`
//     unescaping; for the others, fall back to a manual-unescape
//     helper.
//
//   - Anything else (`.d.ts`, missing files, etc.): null.
//
// Returns null when no template is found OR the file has multiple
// templates (multi-template guard mirrors the existing
// `parseGtsFile` constraint).
function extractTemplateContent(filename: string): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(filename, 'utf8');
  } catch {
    return null;
  }
  if (filename.endsWith('.gts') || filename.endsWith('.gjs')) {
    let blocks: ReturnType<Preprocessor['parse']>;
    try {
      blocks = preprocessor.parse(contents, { filename });
    } catch {
      return null;
    }
    const templateBlocks = blocks.filter((b) => b.tagName === 'template');
    if (templateBlocks.length !== 1) return null;
    return templateBlocks[0]!.contents;
  }
  if (filename.endsWith('.js') || (filename.endsWith('.ts') && !filename.endsWith('.d.ts'))) {
    return extractTemplateFromJsLikeViaTs(filename, contents);
  }
  return null;
}

// Use TypeScript's parser (loaded transitively by Glint) to walk
// the JS/TS AST for `precompileTemplate("…", …)` or `template("…", …)`
// CallExpressions and extract the first argument's string literal.
// Robust to JS string-literal escape forms (`\n`, `\"`, etc.) —
// TypeScript handles the unescaping for us via the literal's
// `text` property.
//
// Returns null when:
//   - TypeScript can't be resolved (no Glint deps loaded yet)
//   - the file has zero or multiple `precompileTemplate`/`template`
//     calls (the multi-template guard mirrors `parseGtsFile`)
//   - the call's first argument isn't a static string literal
//     (template literals with `${…}` interpolation, etc.)
function extractTemplateFromJsLikeViaTs(filename: string, contents: string): string | null {
  let ts: typeof TS | null;
  try {
    // TS is loaded by Glint's createRequire from the closest
    // node_modules. Reuse the same path so we don't introduce a
    // hard dependency on `typescript` here. When Glint is absent
    // (no @glint/ember-tsc in the project), this returns null —
    // the polymorphic chain trace then declines, same as if no
    // template was found.
    ts = localRequire('typescript') as typeof TS;
  } catch {
    return null;
  }
  const sourceFile = ts.createSourceFile(
    filename,
    contents,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    filename.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const calls: string[] = [];
  function visit(node: TS.Node): void {
    if (calls.length > 1) return;
    if (ts!.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName =
        ts!.isIdentifier(callee)
          ? callee.text
          : ts!.isPropertyAccessExpression(callee) && ts!.isIdentifier(callee.name)
          ? callee.name.text
          : null;
      if (calleeName === 'precompileTemplate' || calleeName === 'template') {
        const arg = node.arguments[0];
        if (arg && ts!.isStringLiteralLike(arg) && !ts!.isNoSubstitutionTemplateLiteral(arg)) {
          calls.push(arg.text);
        } else if (arg && ts!.isNoSubstitutionTemplateLiteral(arg)) {
          calls.push(arg.text);
        }
      }
    }
    ts!.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (calls.length !== 1) return null;
  return calls[0]!;
}

// Resolve `this.<propName>` to a polymorphic source by reading the
// class's getter body. Recognizes the HDS convention:
//
//   get componentTag(): HdsTextTags {
//     const { tag = 'span' } = this.args;
//     return tag;
//   }
//
// Returns `{ kind: 'arg', argName: 'tag' }` for that example. The
// default value is currently NOT propagated (would matter for
// "consumer didn't pass arg" → use default-tag); a no-arg consumer
// is already covered by the leaf-fallback's transparent path.
//
// Anything fancier (computed via conditionals, parameter-validation
// asserts, etc.) returns null and the caller falls through.
function resolveThisPropPolymorphic(
  filename: string,
  source: string,
  propName: string,
): ResolvedPolymorphicTag | null {
  // Use TS's parser instead of regex on getter / destructuring
  // shapes — `.gts` source compresses the destructuring on one
  // line but the compiled `.js` (v2-addon shipping mode) prints
  // it across multiple lines, plus authors might equivalently
  // write `let` / `const`, comments interleaved, or a bare
  // `return this.args.tag ?? 'span'` form. Pattern-matching the
  // AST handles each shape uniformly.
  let ts: typeof TS | null;
  try {
    ts = localRequire('typescript') as typeof TS;
  } catch {
    return null;
  }
  const sf = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    filename.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  let result: ResolvedPolymorphicTag | null = null;
  function visit(node: TS.Node): void {
    if (result) return;
    if (
      ts!.isGetAccessor(node) &&
      ts!.isIdentifier(node.name) &&
      node.name.text === propName &&
      node.body
    ) {
      result = analyzeGetterBody(ts!, node.body);
      return;
    }
    ts!.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}

// Look for the HDS-convention shape inside a getter body:
//   const { argName = 'default' } = this.args;
//   return argName;
// or equivalent via `let`. Returns `{ kind: 'arg', argName }` when
// the pattern matches; null otherwise.
function analyzeGetterBody(
  ts: typeof TS,
  body: TS.Block,
): ResolvedPolymorphicTag | null {
  let destructuredArg: string | null = null;
  for (const stmt of body.statements) {
    if (
      ts.isVariableStatement(stmt) &&
      stmt.declarationList.declarations.length === 1
    ) {
      const decl = stmt.declarationList.declarations[0]!;
      // RHS must be `this.args`.
      if (
        !decl.initializer ||
        !ts.isPropertyAccessExpression(decl.initializer) ||
        decl.initializer.expression.kind !== ts.SyntaxKind.ThisKeyword ||
        decl.initializer.name.text !== 'args'
      ) {
        continue;
      }
      // LHS must be an object-destructuring with a single binding
      // we can name (with or without a default).
      if (!ts.isObjectBindingPattern(decl.name)) continue;
      const elements = decl.name.elements;
      if (elements.length !== 1) continue;
      const elem = elements[0]!;
      if (!ts.isIdentifier(elem.name)) continue;
      destructuredArg = elem.name.text;
      continue;
    }
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      // Accept `return argName` (matching the destructured name).
      if (
        ts.isIdentifier(stmt.expression) &&
        destructuredArg !== null &&
        stmt.expression.text === destructuredArg
      ) {
        return { kind: 'arg', argName: destructuredArg };
      }
    }
  }
  return null;
}

// Local helpers — duplicate of `isNativeTag` from blank.ts and a
// regex-based import resolver. Avoids cross-module dep cycle:
// component-attrs.ts is imported by blank.ts, and we'd otherwise
// need a circular import for `isNativeTag` and a copy of the
// import-resolver logic.
function isNativeTagLocal(tag: string): boolean {
  // Glimmer treats lowercase tags as native; PascalCase as components.
  return /^[a-z]/.test(tag);
}

function resolveLocalImport(consumerFile: string, componentName: string): string | null {
  // Walk the consumer's source for an `import COMPONENT from
  // 'path';` statement. Resolves relative `.gts/.gjs/.ts` paths and
  // simple bare-package imports under `node_modules`.
  let source: string;
  try {
    source = fs.readFileSync(consumerFile, 'utf8');
  } catch {
    return null;
  }
  // Match: `import NAME from 'PATH';` (default import only).
  const re = new RegExp(
    String.raw`import\s+(?:type\s+)?` +
      String.raw`(?:\{\s*default\s+as\s+)?` +
      `${componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` +
      String.raw`(?:\s*\})?` +
      String.raw`\s+from\s+['"]([^'"]+)['"]`,
    'm',
  );
  const m = re.exec(source);
  if (!m) return null;
  const spec = m[1]!;
  const dir = path.dirname(consumerFile);
  // Relative path
  if (spec.startsWith('.')) {
    for (const ext of ['', '.gts', '.gjs', '.ts', '.tsx', '.js']) {
      const candidate = path.resolve(dir, spec + ext);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  }
  // Skip bare-package resolution here — the polymorphic chain is
  // typically within one addon package; cross-package walks are
  // already covered by `outer-wrapper-resolver.ts`.
  return null;
}

// Walk a parsed Glimmer template AST and return the splatted-root
// element, or — if no element is splatted — the first top-level element.
// Returns null when the template has no element children at all.
function findSplattedRoot(ast: AST.Template): AST.ElementNode | null {
  let splatted: AST.ElementNode | null = null;
  let firstElement: AST.ElementNode | null = null;
  traverse(ast, {
    ElementNode: {
      enter(node) {
        if (firstElement === null) firstElement = node;
        if (splatted === null && elementHasSplat(node)) {
          splatted = node;
        }
      },
    },
  });
  return splatted ?? firstElement;
}

// Parse a `.gts` file, extract literal attributes from each `<template>`
// block's splatted root, and return a list of `{tag, attrs}` records.
// Most files have one `<template>` (and one component); some files have
// multiple (e.g. multiple TOC consts + a default export). Caller picks
// the relevant entry by index or by template-content matching.
//
// Returns [] on read/parse failure (caller falls back to the placeholder
// path in blank.js).
function parseGtsFile(filename: string): ComponentAttrs[] {
  let contents: string;
  try {
    contents = fs.readFileSync(filename, 'utf8');
  } catch {
    return [];
  }
  let blocks: ReturnType<Preprocessor['parse']>;
  try {
    blocks = preprocessor.parse(contents, { filename });
  } catch {
    return [];
  }
  const out: ComponentAttrs[] = [];
  for (const block of blocks) {
    if (block.tagName !== 'template') continue;
    let ast: AST.Template;
    try {
      ast = preprocess(block.contents);
    } catch {
      continue;
    }
    const root = findSplattedRoot(ast);
    if (!root) continue;
    // Record the template block's byte range (as content-tag reports
    // it on the original .gts source). Glint's side compares this to
    // the resolving declaration's TS-side range — the root whose
    // template falls inside the declaration's range is the one the
    // declaration owns. This makes multi-template files (helpers +
    // default export, multi-export TOC sets) resolve correctly:
    // without it, the leaf-fallback picks `roots[0]` and tags every
    // consumer of any component in the file with the first
    // template's root tag.
    out.push({
      tag: root.tag,
      attrs: literalAttrs(root),
      hasSplat: elementHasSplat(root),
      templateStart: block.range.startChar,
      templateEnd: block.range.endChar,
    });
  }
  return out;
}

// Public entry point: returns an array of splatted-root descriptors for
// every `<template>` block in the given `.gts` file. Cached per filename.
// Caller selects the right entry (typically index 0 for single-template
// files, or by some other heuristic for multi-template files).
export function getSplattedRootsForFile(filename: string): ComponentAttrs[] {
  const cached = cache.get(filename);
  if (cached !== undefined) {
    return cached;
  }
  const result = parseGtsFile(filename);
  cache.set(filename, result);
  return result;
}

// Helper for testing without going through the file system: parse a
// template-content string directly and return its splatted-root descriptor.
export function extractSplattedRootFromTemplate(
  templateContents: string,
): ComponentAttrs | null {
  let ast: AST.Template;
  try {
    ast = preprocess(templateContents);
  } catch {
    return null;
  }
  const root = findSplattedRoot(ast);
  if (!root) return null;
  return {
    tag: root.tag,
    attrs: literalAttrs(root),
    hasSplat: elementHasSplat(root),
  };
}

// Test-only: clear the per-filename cache.
export function _clearCache(): void {
  cache.clear();
}
