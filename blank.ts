import { preprocess, traverse } from '@glimmer/syntax';
import type { AST } from '@glimmer/syntax';

// At runtime, AST node `loc` fields are `SourceSpan` instances that
// expose `getStart()` / `getEnd()` returning a `SourceOffset` with a
// `.offset` byte-position. The public `SourceLocation` type only
// declares `start`/`end` as `Position { line, column }` (no offset),
// and `SourceSpan` itself isn't re-exported at the package's top level.
// We need byte offsets for length-preserved rewrites — declare the
// minimum shape we rely on and cast through it at access points.
interface SpanLike {
  getStart(): { offset: number };
  getEnd(): { offset: number };
}
function startOffset(node: { loc: AST.SourceLocation }): number {
  return (node.loc as unknown as SpanLike).getStart().offset;
}
function endOffset(node: { loc: AST.SourceLocation }): number {
  return (node.loc as unknown as SpanLike).getEnd().offset;
}
import htmlTags from 'html-tags';
import svgTags from 'svg-tags';
import { mathmlTagNames } from 'mathml-tag-names';
import html5Schema from 'html-validate/elements/html5';
import type { MetaDataTable } from 'html-validate';

import { lookupBuiltinComponent } from './lib/builtin-components.js';
import type { ComponentAttrs } from './lib/builtin-components.js';
import type { AttrTypeInfo } from './lib/cache.js';

// ---------------------------------------------------------------------------
// Schema-derived metadata (computed once at module load).
// ---------------------------------------------------------------------------

// Native boolean attributes per HTML5. Sourced from html-validate's
// elements/html5 schema (the same data we use for attribute-allowed-values).
// Used to decide how a bare-mustache value gets emitted: a boolean attr
// resolves at runtime to either presence-only (when truthy) or omit (when
// falsy), per docs/glimmer-attribute-behavior.md. We emit presence-only —
// the canonical "rendered" form — letting attribute-boolean-style stay
// enabled. Non-boolean bare-mustache attrs use the empty-quoted +
// processAttribute DynamicValue path.
const html5: MetaDataTable = html5Schema;

const BOOLEAN_ATTR_KEYS: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const [tag, schema] of Object.entries(html5)) {
    const attrs = schema?.attributes ?? {};
    for (const [name, meta] of Object.entries(attrs)) {
      if (meta && (meta as { boolean?: boolean }).boolean === true) {
        set.add(`${tag}/${name}`);
      }
    }
  }
  return set;
})();

// Same authoritative element-name list as eslint-plugin-ember's
// `isNativeElement` util (lib/utils/is-native-element.js).
const NATIVE_TAGS: ReadonlySet<string> = new Set([
  ...htmlTags,
  ...svgTags,
  ...mathmlTagNames,
]);

// HTML5 void elements (no closing tag, no children). Used to choose
// between in-place tag rename (void: keeps parent attrs visible) and
// open+close-pair emission (non-void: needs explicit content).
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

function isBooleanAttr(tagName: string, attrName: string): boolean {
  return BOOLEAN_ATTR_KEYS.has(`${tagName}/${attrName}`) || BOOLEAN_ATTR_KEYS.has(`*/${attrName}`);
}

// Returns the html-validate enum constraint for an attribute on a given
// element, or null when the attribute has no enum or isn't in the schema.
// Filters out regex-string entries (which html-validate uses for numerics
// like maxlength) — we only handle pure-string enums for branch validation.
function attrEnumFor(tagName: string, attrName: string): string[] | null {
  const schemas = [html5[tagName], html5['*']];
  for (const schema of schemas) {
    const meta = schema?.attributes?.[attrName] as { enum?: unknown[] } | undefined;
    if (meta && Array.isArray(meta.enum)) {
      const strings = meta.enum.filter(
        (v): v is string => typeof v === 'string' && !v.startsWith('/'),
      );
      if (strings.length > 0) {
        return strings;
      }
    }
  }
  return null;
}

// For a string-literal-union from Glint (e.g. ['text','select','number','date']),
// against an html-validate enum (e.g. valid <input type> values), return the
// first union member NOT in the enum — that's the bug we surface. If all
// values are valid, return the first (status quo).
//
// Example: `<input type={{@x}}>` where @x: 'text'|'select' → enum has
// 'text' but not 'select' → emit 'select' so attribute-allowed-values fires.
function pickRevealingValue(unionValues: string[], tagName: string, attrName: string): string {
  const fallback = unionValues[0] ?? '';
  const enumValues = attrEnumFor(tagName, attrName);
  if (!enumValues) {
    return fallback;
  }
  const enumSet = new Set(enumValues.map((v) => v.toLowerCase()));
  for (const value of unionValues) {
    if (!enumSet.has(value.toLowerCase())) {
      return value;
    }
  }
  return fallback;
}

function isNativeTag(tag: string): boolean {
  return NATIVE_TAGS.has(tag);
}

// ---------------------------------------------------------------------------
// AST predicates and small utilities.
// ---------------------------------------------------------------------------

function isGlimmerOnlyAttr(name: string | undefined | null): boolean {
  if (!name) return false;
  return name.startsWith('@') || name === '...attributes' || name === 'as' || name.startsWith('|');
}

type Range = [number, number];

interface NodeWithLoc {
  loc: AST.SourceLocation;
}

function rangeOf(node: NodeWithLoc): Range {
  return [startOffset(node), endOffset(node)];
}

// True when any of the element's children is a Glimmer dynamic construct
// OR a non-native component invocation (PascalCase / dotted-path).
// Used to flag the element for `processElement`'s DynamicValue text content
// — even mixed-content cases (e.g. `<button>{{t 'Save'}} <kbd>⌘S</kbd></button>`)
// where a real label is dynamic but other static markup is also present;
// without the marker, rules like `text-content` may treat the static portion
// as the accessible name and miss issues with the dynamic portion.
//
// Component-child case: `<a><FormattedText @value={{x}} /></a>` — the
// component renders text at runtime, but our transparent substitution
// blanks the component's tags entirely, leaving the anchor empty in the
// output we hand html-validate. Without flagging the parent as dynamic,
// `wcag/h30` / `text-content` / `empty-heading` FP-fire. Trade-off: we
// also silence those rules when the component genuinely renders no text
// (icon-only via component, e.g. `<a><MyIcon /></a>`) — but icon-only
// patterns are usually native (`<svg>`, `<i>`) and still get caught.
function elementHasDynamicContent(node: AST.ElementNode): boolean {
  const children = node.children ?? [];
  for (const child of children) {
    if (
      child.type === 'MustacheStatement' ||
      child.type === 'BlockStatement' ||
      child.type === 'MustacheCommentStatement'
    ) {
      return true;
    }
    if (child.type === 'ElementNode' && !isNativeTag(child.tag)) {
      return true;
    }
  }
  return false;
}

// Recursively walk a Glimmer subtree (Block / Element children) looking for
// a submit-style form control: `<button type='submit'>` or `<input
// type='submit'|'image'>`. Used by the BlockStatement handler to decide
// which branch of `{{#if}}/{{else}}` to emit when one branch is the
// "submitting" branch — single-branch emission would otherwise hide the
// submit button and FP-fire `wcag/h32`.
function blockHasSubmitButton(programOrInverse: AST.Block | null | undefined): boolean {
  if (!programOrInverse?.body) return false;
  for (const child of programOrInverse.body) {
    if (nodeHasSubmitButton(child)) return true;
  }
  return false;
}

function nodeHasSubmitButton(node: AST.Statement | AST.TopLevelStatement): boolean {
  if (node.type === 'ElementNode') {
    if (node.tag === 'button' || node.tag === 'input') {
      for (const attr of node.attributes ?? []) {
        if (attr.name === 'type' && attr.value.type === 'TextNode') {
          const v = attr.value.chars;
          if (v === 'submit' || v === 'image') return true;
        }
      }
    }
    for (const child of node.children ?? []) {
      if (nodeHasSubmitButton(child)) return true;
    }
  } else if (node.type === 'BlockStatement') {
    if (blockHasSubmitButton(node.program)) return true;
    if (node.inverse && blockHasSubmitButton(node.inverse)) return true;
  }
  return false;
}

// Returns the literal value if `node` is a string literal whose contents are
// safe to embed into our blanked HTML output (no chars that would alter HTML
// structure or shift columns).
function safeLiteralString(node: AST.Expression | undefined): string | null {
  if (!node || node.type !== 'StringLiteral' || typeof node.value !== 'string') {
    return null;
  }
  if (/[<>&"'\\\n\r]/u.test(node.value)) {
    return null;
  }
  return node.value;
}

interface AttrCtx {
  attrTagName?: string;
  attrName?: string;
}

// Returns the static string a MustacheStatement would render to, or null
// when we can't resolve. Handles:
//   `{{t 'Key'}}`          → 'Key'  (ember-intl translation key as placeholder)
//   `{{if cond 'a' 'b'}}`  → 'a'   (pick the truthy branch when both literals)
//   `{{NAME}}`             → lookup NAME in `scope` (top-level string consts
//                             extracted from the .gts JS portion).
//   Glint type lookup     → string-literal or string-literal-union from
//                             component Signature. For unions, picks a value
//                             that exposes the bug — see pickRevealingValue.
function tryStaticText(
  node: AST.MustacheStatement,
  scope: ReadonlyMap<string, string> | undefined,
  glintTypeMap: ReadonlyMap<string, AttrTypeInfo> | undefined | null,
  attrCtx?: AttrCtx,
): string | null {
  // Glint type lookup: when @glint/ember-tsc resolves the mustache to a
  // string-literal type (or string-literal union), use the literal as the
  // static-text substitute. For unions in attribute positions where the
  // attribute has an html-validate enum, pick a union member NOT in the
  // enum (if any) so the user's union-type definition surfaces as a real
  // attribute-allowed-values violation. Otherwise pick the first branch.
  if (glintTypeMap && node.loc.start) {
    const key = `${node.loc.start.line}:${node.loc.start.column}`;
    const typeInfo = glintTypeMap.get(key);
    if (
      typeInfo &&
      (typeInfo.kind === 'string-literal' || typeInfo.kind === 'string-literal-union')
    ) {
      let value: string | undefined = typeInfo.values[0];
      if (
        typeInfo.kind === 'string-literal-union' &&
        attrCtx?.attrTagName &&
        attrCtx.attrName
      ) {
        value = pickRevealingValue(typeInfo.values, attrCtx.attrTagName, attrCtx.attrName);
      }
      if (typeof value === 'string' && !/[<>&"'\\\n\r]/u.test(value)) {
        return value;
      }
    }
  }

  const path = node.path;
  if (
    !path ||
    path.type !== 'PathExpression' ||
    (path.head.type !== 'VarHead' && path.head.type !== 'ThisHead')
  ) {
    return null;
  }
  const helper = path.original;

  // Bare reference — no params, no hash. Resolve against `scope`.
  // The map is keyed by the path's `original` text:
  //   - `{{NAME}}`         → scope.get('NAME')         (top-level const)
  //   - `{{this.field}}`   → scope.get('this.field')   (class field)
  if (
    scope &&
    (!node.params || node.params.length === 0) &&
    (!node.hash || !node.hash.pairs || node.hash.pairs.length === 0)
  ) {
    const value = scope.get(helper);
    if (value !== undefined && !/[<>&"'\\\n\r]/u.test(value)) {
      return value;
    }
  }

  // Helper-form lookups (`{{t 'Key'}}` / `{{if cond 'a' 'b'}}`) are only
  // meaningful for VarHead; `{{this.t 'Key'}}` would be a method call,
  // not the t-helper.
  if (path.head.type === 'VarHead') {
    if (helper === 't') {
      return safeLiteralString(node.params[0]);
    }
    if (helper === 'if') {
      const truthy = safeLiteralString(node.params[1]);
      if (truthy !== null) return truthy;
      return safeLiteralString(node.params[2]);
    }
  }
  return null;
}

// Position-finding helpers. We re-scan the source string rather than rely
// solely on AST locs because the AST doesn't directly expose the "open tag
// end" / "close tag start" offsets we need for byte-accurate substitution.
//
// Skip past:
//   - Quoted strings (`"..."` and `'...'`)
//   - Mustache pairs (`{{...}}`, including `{{!-- --}}` and `{{! }}`)
// so a `>` character inside any of those doesn't false-trigger.
function findOpenTagEnd(content: string, openStart: number): number {
  for (let i = openStart + 1; i < content.length; i++) {
    const ch = content[i];
    if (ch === '>') {
      return i;
    }
    if (ch === '"' || ch === "'") {
      const close = content.indexOf(ch, i + 1);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    if (ch === '{' && content[i + 1] === '{') {
      // Skip past matching `}}`. Glimmer mustaches don't nest at the
      // top level here (we're inside an HTML element open tag, not
      // inside another mustache), so a flat `indexOf` is fine. Long-
      // form comments `{{!-- ... --}}` end with `--}}` which still
      // ends in `}}`, so the same scan works.
      const close = content.indexOf('}}', i + 2);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
  }
  return -1;
}

function findCloseTagStart(content: string, elementEnd: number): number {
  for (let i = elementEnd - 1; i >= 0; i--) {
    if (content[i] === '<') {
      return i;
    }
  }
  return -1;
}

// `@glimmer/syntax`'s parser doesn't understand TS-flavored block params:
// `{{#each items as |x: T|}}` is sometimes accepted (single simple
// type), sometimes rejected (multi-param + comma, qualified types,
// object/parenthesized/union types). When parse fails the whole
// template is silently skipped. We pre-process the `as |…|` interior
// so Glimmer sees the normalized space-separated form `as |a b|`
// regardless. Length-preserving — every stripped char becomes a space
// so AST loc offsets after the strip match the original source.
//
// Strategy: walk the source linearly, find each mustache opener
// `{{…}}`, locate `as |` and the matching closing `|` (last `|` before
// `}}`), then walk the param list character-by-character with balanced-
// bracket tracking for `()`, `{}`, `<>`, `[]` so union (`A | B`),
// object (`{ a: number }`), parenthesized (`(A | B)[]`), and generic
// (`Map<string, number>`) types are stripped correctly.
function stripBlockParamTypeAnnotations(content: string): string {
  const buf = content.split('');
  let i = 0;
  while (i < content.length - 1) {
    if (content[i] !== '{' || content[i + 1] !== '{') {
      i++;
      continue;
    }
    const mustacheEnd = content.indexOf('}}', i + 2);
    if (mustacheEnd < 0) break;
    // Find the start of the param list — the `|` after `as`.
    const asMatch = /\bas\s*\|/.exec(content.slice(i, mustacheEnd));
    if (!asMatch) {
      i = mustacheEnd + 2;
      continue;
    }
    const paramStart = i + asMatch.index + asMatch[0].length;
    // The closing `|` is the LAST `|` before `}}` in the opener — `|`s
    // before it are union operators inside types.
    const paramEnd = content.lastIndexOf('|', mustacheEnd - 1);
    if (paramEnd <= paramStart) {
      i = mustacheEnd + 2;
      continue;
    }
    stripBlockParamRange(buf, paramStart, paramEnd);
    i = mustacheEnd + 2;
  }
  return buf.join('');
}

// Walk `[start, end)` (the chars between the opening and closing `|`
// of `as |…|`), find each `name: TypeExpr` pair and replace the
// `:` + type-expression bytes with spaces. Comma separators between
// params also become spaces so Glimmer's space-separated grammar is
// happy. Length-preserved throughout.
function stripBlockParamRange(buf: string[], start: number, end: number): void {
  const isWS = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
  const opens = '({[<';
  const closes = ')}]>';

  let i = start;
  while (i < end) {
    // Skip whitespace.
    while (i < end && isWS(buf[i] ?? '')) i++;
    if (i >= end) return;

    // Comma between params — strip to space and continue.
    if (buf[i] === ',') {
      buf[i] = ' ';
      i++;
      continue;
    }

    // Read identifier (the param name).
    const idStart = i;
    while (i < end && isIdent(buf[i] ?? '')) i++;
    if (i === idStart) {
      // Unexpected char — defensively advance.
      i++;
      continue;
    }

    // Skip whitespace, then look for `:` (the type annotation marker).
    while (i < end && isWS(buf[i] ?? '')) i++;
    if (i >= end || buf[i] !== ':') continue;

    // Walk the type expression with bracket-depth tracking. Terminates
    // at `,` at depth 0 (next param separator) or end of range. `|` at
    // any depth is part of the type (union operator), never a separator
    // — the closing `|` of `as |…|` is OUTSIDE the range we're given.
    const typeStart = i;
    let depth = 0;
    while (i < end) {
      const c = buf[i] ?? '';
      if (opens.includes(c)) {
        depth++;
      } else if (closes.includes(c)) {
        if (depth > 0) depth--;
      } else if (c === ',' && depth === 0) {
        break;
      }
      i++;
    }
    for (let k = typeStart; k < i; k++) {
      const c = buf[k];
      if (c !== '\n' && c !== '\r') {
        buf[k] = ' ';
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-element handlers. Each takes the AST node + a mutable `ctx` object
// that accumulates the rewrite plan (blank ranges, renames, etc.).
// ---------------------------------------------------------------------------

type BranchChoice = 'program' | 'inverse';

interface Context {
  content: string;
  scope: ReadonlyMap<string, string> | undefined;
  glintTypeMap: ReadonlyMap<string, AttrTypeInfo> | null | undefined;
  glintComponentTagMap: ReadonlyMap<string, string> | null | undefined;
  glintComponentAttrMap: ReadonlyMap<string, ComponentAttrs> | null | undefined;
  blankRanges: Range[];
  renames: Array<[number, number, string]>;
  fullyBlankedRanges: Range[];
  dynamicContentOffsets: number[];
  effectiveComponentAttrMap?: Map<string, ComponentAttrs>;
  // When set, `handleBlockStatement` uses the selection from this map
  // (keyed by the BlockStatement's source-start offset) instead of the
  // default form-submit-aware heuristic. Drives `blankTemplateContentMultipass`,
  // which enumerates branch combinations to validate each independently.
  branchSelections?: ReadonlyMap<number, BranchChoice>;
  inFullyBlankedRange(offset: number): boolean;
}

// Default fallback for component invocations without Glint resolution
// (or as a fallback when source is too short for native substitution).
//
// Blank the open and close tags ENTIRELY — children float to the actual
// parent for content-model checks. This is the same treatment Glint uses
// when `Signature['Element']` resolves to `unknown`/`any`.
//
// Example: `<table><TheadComponent><tr>...</tr></TheadComponent></table>`
// becomes `<table>                  <tr>...</tr>                   </table>`
// — html-validate sees `<tr>` as a direct child of `<table>` (which IS
// allowed), so `element-permitted-content` doesn't fire.
//
// Trade-off: we lose content-model verification ON the component itself
// (we can't say "this component renders block content; it shouldn't be
// inside a phrasing-only parent" without Glint type info). The previous
// `<x-c>` placeholder approach also couldn't do that — and additionally
// FP-fired in strict-content parents like `<table>` / `<ul>` / `<dl>` /
// `<select>` / `<menu>` because `<x-c>` itself isn't an allowed child
// there. Transparent treatment avoids those FPs at the cost of some
// detection power for clearly-misnested components.
function neutralizeComponent(node: AST.ElementNode, ctx: Context): void {
  blankComponentTagsTransparent(node, ctx);
}

// Attempt Glint-driven component substitution. Returns the resolved native
// tag name when handled (caller should treat the element as a native tag
// for attribute processing) or null when the caller should fall back to
// neutralizeComponent. Three cases based on what Glint resolves for the
// component's `Signature['Element']`:
//
//   1. Known DOM tag (e.g. HTMLButtonElement → 'button') — rename in place
//      (block form) or emit `<RESOLVED type=' '>...</RESOLVED>` (self-
//      closing form, FP-fix for empty-element rules).
//   2. 'transparent' (Element === unknown / any) — yields-only / no
//      Element declared. Blank open/close tags, keep children. They float
//      into the parent's content model.
//   3. Anything else — caller falls back to neutralizeComponent (transparent).
function handleGlintSubstitution(node: AST.ElementNode, ctx: Context): string | null {
  if (isNativeTag(node.tag) || !node.loc.start) {
    return null;
  }
  const key = `${node.loc.start.line}:${node.loc.start.column}`;

  // Glint-driven resolution takes precedence (per-invocation accurate).
  // Fall back to the built-in Ember component map for canonical
  // components Glint either can't see (`.hbs` runs) or didn't surface
  // (running without `--glint`). The built-ins also seed `attrCtx` so
  // splatted-root attribute injection works for them without a real
  // file walk (we ship the metadata). Glint can return a tag-only
  // entry for canonical components (e.g. `LinkTo` resolved via
  // `@ember/routing` types — no project `.gts` to read for the
  // splatted root); in that case we still need the builtin's
  // attrs as long as its canonical tag matches what Glint resolved.
  //
  // Trade-off: a project that shadows a built-in name (a user-defined
  // component literally called `LinkTo` resolving to `<a>` but not
  // necessarily rendering `href`) gets the canonical builtin's
  // attrs applied here, masking any anchor/aria errors on the
  // shadow. This is the same FN risk the `.hbs` path has always
  // carried (no Glint there, so the built-in wins by name); we
  // accept it for consistency rather than leave canonical `<LinkTo>`
  // in `.gts` permanently FP-flagged.
  let resolved: string | undefined = ctx.glintComponentTagMap?.get(key);
  let attrCtx: ComponentAttrs | undefined = ctx.glintComponentAttrMap?.get(key);
  if (!resolved || !attrCtx) {
    const builtin = lookupBuiltinComponent(node.tag);
    if (builtin) {
      if (!resolved) resolved = builtin.tag;
      if (!attrCtx && resolved === builtin.tag) attrCtx = builtin;
    }
  }

  if (resolved === 'transparent') {
    blankComponentTagsTransparent(node, ctx);
    return 'transparent';
  }

  if (typeof resolved !== 'string' || resolved.length > node.tag.length) {
    return null;
  }

  // Stash the resolved attrCtx in ctx for later lookup helpers
  // (lookupComponentAttr) — they currently key off
  // ctx.glintComponentAttrMap, but we want builtin-derived attrCtx to
  // be visible too. Rather than threading a parameter through several
  // call sites, write the entry into a per-call effective map.
  if (attrCtx && !ctx.glintComponentAttrMap?.has(key)) {
    if (!ctx.effectiveComponentAttrMap) {
      ctx.effectiveComponentAttrMap = new Map(ctx.glintComponentAttrMap ?? []);
    }
    ctx.effectiveComponentAttrMap.set(key, attrCtx);
  }

  if (node.selfClosing) {
    // Two paths depending on whether the resolved native is void:
    //   - Void natives (input, img, br, hr, …): in-place tag rename keeps
    //     the parent's non-Glimmer attrs (id, class, name, data-*) visible
    //     for validation. Glimmer-only attrs (`@arg`, modifiers,
    //     `...attributes`) are blanked. For <input>, we additionally
    //     inject `type=' '` into a Glimmer-attr blank area so
    //     `no-implicit-input-type` doesn't FP-fire (the actual `type`
    //     comes from the component's internal template, which we can't
    //     see).
    //   - Non-void natives (button, span, …): open+close-pair emission.
    //     Loses parent attrs but supplies content via DynamicValue text
    //     (registered in dynamicContentOffsets) and `type=' '` for button.
    if (VOID_ELEMENTS.has(resolved)) {
      return substituteSelfClosingVoidComponent(node, ctx, resolved) ? resolved : null;
    }
    return substituteSelfClosingComponent(node, ctx, resolved) ? resolved : null;
  }

  // Block-form: rename open and close tags in place. Children stay visible
  // to html-validate.
  const elementStart = startOffset(node);
  const elementEnd = endOffset(node);
  const tagStart = elementStart + 1;
  const padding = ' '.repeat(node.tag.length - resolved.length);
  ctx.renames.push([tagStart, tagStart + node.tag.length, resolved + padding]);
  const closeTagStart = elementEnd - node.tag.length - 1;
  ctx.renames.push([closeTagStart, closeTagStart + node.tag.length, resolved + padding]);
  // Inject the resolved component's static attrs into Glimmer-attr blank
  // regions in the open tag (mirrors the self-closing input-type
  // injection). Without this, e.g. <LinkTo>...</LinkTo> resolves to a
  // bare <a> with no href — html-validate then treats it as
  // non-interactive and FP-fires `aria-label-misuse` and other
  // role-dependent rules. The same mechanism gives Glint-resolved
  // components a way to surface canonical attrs (e.g. a custom
  // <SubmitButton> that always renders <button type='submit'>).
  if (attrCtx && Object.keys(attrCtx.attrs).length > 0) {
    tryInjectComponentAttrs(node, ctx, resolved, attrCtx.attrs);
  }
  return resolved;
}

// Self-closing component substituted to a void native (input, img, br,
// …). In-place tag-name rename — the existing attribute-processing loop
// in handleElementNode then preserves non-Glimmer attrs (id, class,
// name, …) and blanks Glimmer-only attrs. For <input>, additionally
// inject `type=' '` into a Glimmer-attr blank area so
// `no-implicit-input-type` doesn't FP-fire.
//
// Returns true on successful substitution; false when source is too
// short to fit the resolved tag name (caller falls back to transparent
// neutralization).
function substituteSelfClosingVoidComponent(
  node: AST.ElementNode,
  ctx: Context,
  resolved: string,
): boolean {
  const elementStart = startOffset(node);
  // Minimum required: room for `<RESOLVED` (tag-name rename only).
  if (node.tag.length < resolved.length) return false;
  const tagStart = elementStart + 1;
  const padding = ' '.repeat(node.tag.length - resolved.length);
  ctx.renames.push([tagStart, tagStart + node.tag.length, resolved + padding]);
  // For <input>, find a Glimmer-attr blank area to inject `type=' '`.
  if (resolved === 'input') {
    tryInjectInputType(node, ctx);
  }
  return true;
}

// Find a Glimmer-only attribute (`@arg`, modifier, `...attributes`)
// whose source span has room for `type='X'` (no newlines), and rewrite
// the first chars of that span. The remainder of the attribute's range
// stays in `blankRanges` (added by emitAttribute), so the area outside
// our injection becomes spaces.
//
// Two strategies for the value:
//   1. If `glintComponentAttrMap` has a literal `type` for this
//      component (the splatted-root has a literal `type='range'`-style
//      attribute), inject the actual value: `<input type='range' ...`.
//      Lets html-validate validate the value against the enum.
//   2. Otherwise, inject `type='   '` (3-space placeholder). The
//      `processAttribute` hook converts the whitespace value to
//      DynamicValue (its >=3-char threshold), so `attribute-allowed-
//      values` doesn't fire on the placeholder.
//
// No-op when no suitable attr area is found — `no-implicit-input-type`
// will still fire in that case, but the user can silence per-site.

// Symmetric to tryInjectInputType but for void natives whose required attrs
// can be supplied by the consumer via `...attributes`. Without injection,
// `<img ...attributes>` blanks to an attribute-less `<img>` and html-validate
// FP-fires `element-required-attributes` (src) and `wcag/h37` (alt) even
// though both come from the splat at runtime.
//
// Injects whitespace-valued placeholders (`src='   '` / `alt='   '`) into
// Glimmer-only blank regions in the open tag; `processAttribute`'s
// DynamicValue conversion (>=3-char whitespace threshold) then surfaces them
// as "present, value unknowable". Skipped when the consumer already wrote
// `src=` / `alt=` explicitly.
//
// Currently scoped to <img>; the same shape applies to
// <source>/<track>/<area>/<iframe> if real-world FPs surface there.
function tryInjectImgRequiredAttrs(node: AST.ElementNode, ctx: Context): void {
  const hasSplat = (node.attributes ?? []).some((a) => a.name === '...attributes');
  if (!hasSplat) return;
  const present = new Set((node.attributes ?? []).map((a) => a.name));
  const wanted: string[] = [];
  if (!present.has('src')) wanted.push("src='   '");
  if (!present.has('alt')) wanted.push("alt='   '");
  if (wanted.length === 0) return;
  const candidates: Range[] = [];
  for (const attr of node.attributes ?? []) {
    if (isGlimmerOnlyAttr(attr.name)) {
      candidates.push([startOffset(attr), endOffset(attr)]);
    }
  }
  for (const m of node.modifiers ?? []) {
    candidates.push([startOffset(m), endOffset(m)]);
  }
  // Sort candidates widest first. Both injected attrs (`src='   '` and
  // `alt='   '`) are 9 chars, so picking the widest candidate first
  // doesn't starve a later attr. This is a slot-side ordering only;
  // tryInjectComponentAttrs additionally sorts the *attrs* by descending
  // text length to prevent starvation when attrs have varying widths —
  // not needed here because both wanted attrs are the same length.
  candidates.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  for (const text of wanted) {
    for (let i = 0; i < candidates.length; i++) {
      const [s, e] = candidates[i]!;
      if (e - s < text.length) continue;
      const slice = ctx.content.slice(s, s + text.length);
      if (/[\n\r]/.test(slice)) continue;
      ctx.renames.push([s, s + text.length, text]);
      candidates.splice(i, 1);
      break;
    }
  }
}

function tryInjectInputType(node: AST.ElementNode, ctx: Context): void {
  const literalType = lookupComponentAttr(node, ctx, 'type');
  // Build the injected text. Prefer a literal value when known and
  // safe (no embedded quotes / HTML-altering chars).
  const valueLiteral = isLiteralSafeForAttr(literalType) ? literalType : null;
  const TYPE_TEXT = valueLiteral !== null ? `type='${valueLiteral}'` : "type='   '";
  const candidates: Range[] = [];
  for (const attr of node.attributes ?? []) {
    if (isGlimmerOnlyAttr(attr.name)) {
      candidates.push([startOffset(attr), endOffset(attr)]);
    }
  }
  for (const m of node.modifiers ?? []) {
    candidates.push([startOffset(m), endOffset(m)]);
  }
  for (const [s, e] of candidates) {
    if (e - s < TYPE_TEXT.length) continue;
    const slice = ctx.content.slice(s, s + TYPE_TEXT.length);
    if (/[\n\r]/.test(slice)) continue;
    ctx.renames.push([s, s + TYPE_TEXT.length, TYPE_TEXT]);
    return;
  }
}

// Generalized attr injection for block-form component substitution.
// For each `(name, value)` in `attrs`, find a Glimmer-only attribute
// or modifier blank region in the open tag with enough room for
// `name='value'` (no newlines), and rewrite it. Each region is used
// by at most one injected attr.
//
// Used today for `<LinkTo>...</LinkTo>` to surface its computed
// `href` so html-validate sees an interactive `<a>`. Generalized
// because the same mechanism applies to any block-form component
// substitution where a Glint-resolved or builtin entry has static
// attrs (e.g. `<SubmitButton>` that always renders
// `<button type='submit'>`).
//
// Value sourcing per attr: prefer a literal looked up via
// `lookupComponentAttr` (matches the self-closing input-type path),
// fall back to a 3-space placeholder so the `processAttribute` hook
// converts the value to `DynamicValue`. The placeholder length must
// be >= 3 to clear that hook's threshold.
function tryInjectComponentAttrs(
  node: AST.ElementNode,
  ctx: Context,
  resolvedTag: string,
  attrs: Readonly<Record<string, string>>,
): void {
  const candidates: Range[] = [];
  // Names already present as non-Glimmer attrs on the invocation; skip
  // injecting these so the substituted tag doesn't carry duplicates
  // (e.g. `<SubmitButton type='button'>` against a splatted root with
  // `type='submit'` would otherwise emit two `type` attrs and trip
  // html-validate's `no-dup-attr`).
  //
  // Limitation: `componentAttrMap` records the literal but not the
  // position of `...attributes` in the splatted root. Two layouts
  // are common in Glimmer:
  //   1. `<button class='primary' type='submit' ...attributes>`
  //      — caller-wins. Conventional, dominant in real code.
  //   2. `<button ...attributes type='submit'>`
  //      — component-wins. Forces a literal regardless of caller.
  // We default to layout (1): drop the canonical attr when the
  // caller supplies the same name. Layout (2) would render the
  // component's value at runtime, which we then misrepresent as
  // the caller's value — but emitting both attrs doesn't actually
  // help: HTML5 parsing also takes the first one, so the validator's
  // DOM view is identical to the caller-wins path. We just avoid
  // the spurious `no-dup-attr` noise for the dominant layout.
  const existingNonGlimmer = new Set<string>();
  for (const attr of node.attributes ?? []) {
    if (isGlimmerOnlyAttr(attr.name)) {
      candidates.push([startOffset(attr), endOffset(attr)]);
    } else {
      existingNonGlimmer.add(attr.name);
    }
  }
  for (const m of node.modifiers ?? []) {
    candidates.push([startOffset(m), endOffset(m)]);
  }
  // Build the injection plan first, then place longer texts before
  // shorter ones. Otherwise a short attr visited first can claim the
  // only candidate slot wide enough for a longer attr, silently
  // dropping it. Empty-string literal on a known boolean attr
  // (e.g. `<button disabled ...attributes>` records `disabled: ''`)
  // emits just the attr name. For non-boolean attrs we can't tell
  // shorthand `disabled` apart from explicit `value=''`, so fall
  // back to the 3-space placeholder — it's HTML5-equivalent and
  // gets DynamicValue-treated by `processAttribute`.
  const plan = Object.keys(attrs)
    .filter((name) => !existingNonGlimmer.has(name))
    .map((attrName) => {
      const literal = lookupComponentAttr(node, ctx, attrName);
      if (literal === '' && isBooleanAttr(resolvedTag, attrName)) {
        return { text: attrName };
      }
      if (isLiteralSafeForAttr(literal)) return { text: `${attrName}='${literal}'` };
      return { text: `${attrName}='   '` };
    });
  plan.sort((a, b) => b.text.length - a.text.length);
  const used = new Set<number>();
  for (const { text } of plan) {
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue;
      const [s, e] = candidates[i]!;
      if (e - s < text.length) continue;
      const slice = ctx.content.slice(s, s + text.length);
      if (/[\n\r]/.test(slice)) continue;
      ctx.renames.push([s, s + text.length, text]);
      used.add(i);
      break;
    }
  }
}

// Look up a literal attribute value from the component's splatted-root.
// Sources, in order of precedence:
//   1. Per-invocation Glint-extracted attrs (`glintComponentAttrMap`).
//   2. Built-in Ember component fallback (Input / Textarea / LinkTo),
//      seeded into `effectiveComponentAttrMap` by handleGlintSubstitution.
// Returns the string value or null when not available.
function lookupComponentAttr(
  node: AST.ElementNode,
  ctx: Context,
  attrName: string,
): string | null {
  if (!node.loc.start) return null;
  const key = `${node.loc.start.line}:${node.loc.start.column}`;
  const map = ctx.effectiveComponentAttrMap ?? ctx.glintComponentAttrMap;
  if (!map) return null;
  const entry = map.get(key);
  return entry?.attrs[attrName] ?? null;
}

// True when the value is safe to embed verbatim into a single-quoted
// HTML attribute: must be a string with no characters that would alter
// HTML structure or shift columns.
function isLiteralSafeForAttr(value: string | null): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  return !/[<>&"'\\\n\r]/u.test(value);
}

// Transparent treatment: blank the component's open and close tags
// entirely. Children float into the parent's content model — more accurate
// than wrapping in `<x-c>` for components that render no DOM (e.g. yield-
// only data-fetcher components).
//
// When `findOpenTagEnd` fails (e.g., the open tag contains a complex
// `{{! ... }}` short-form Glimmer comment that the byte-scan heuristic
// can't reason about), fall back to blanking the entire element so the
// PascalCase tag name doesn't reach html-validate's parser. Trade-off:
// children are also blanked in that fallback case, but that's safer
// than leaking PascalCase tags into the output.
function blankComponentTagsTransparent(node: AST.ElementNode, ctx: Context): void {
  const { content, blankRanges, fullyBlankedRanges } = ctx;
  const elementStart = startOffset(node);
  const elementEnd = endOffset(node);
  const openTagEnd = findOpenTagEnd(content, elementStart);
  if (openTagEnd < 0) {
    blankRanges.push([elementStart, elementEnd]);
    fullyBlankedRanges.push([elementStart, elementEnd]);
    return;
  }
  blankRanges.push([elementStart, openTagEnd + 1]);
  fullyBlankedRanges.push([elementStart, openTagEnd + 1]);
  if (!node.selfClosing) {
    const closeTagStart = findCloseTagStart(content, elementEnd);
    if (closeTagStart >= 0) {
      blankRanges.push([closeTagStart, elementEnd]);
      fullyBlankedRanges.push([closeTagStart, elementEnd]);
    } else {
      // Couldn't locate the close tag — blank to end of element.
      blankRanges.push([elementStart, elementEnd]);
      fullyBlankedRanges.push([elementStart, elementEnd]);
    }
  }
}

// Self-closing component substituted to a non-void native (e.g.
// `<AccessGrant />` resolved to `<button>` because the component declares
// `Signature['Element'] = HTMLButtonElement`). Emit as
// `<RESOLVED type=' '>...</RESOLVED>` open+close pair (length-preserved)
// and register the element offset for DynamicValue text content via
// `processElement`. Without this, the substituted self-closing tag would
// look empty + untyped to html-validate, FP-firing `text-content` and
// `no-implicit-button-type`. The component's actual rendered button has
// both — we just can't see them from the parent template.
//
// Returns true when the substitution succeeded; false when the source span
// is too short and the caller should fall back to transparent neutralization.
function substituteSelfClosingComponent(
  node: AST.ElementNode,
  ctx: Context,
  resolved: string,
): boolean {
  const elementStart = startOffset(node);
  const elementEnd = endOffset(node);
  // Three-space placeholder (not one) so the existing `processAttribute`
  // hook converts it to DynamicValue. A 1-char value would be treated as
  // a literal `' '` and trigger `attribute-allowed-values` (`' '` isn't
  // in `<button type>`'s enum). When Glint has resolved the component's
  // splatted root and exposes a literal `type` attribute, prefer that —
  // gives html-validate the actual value to enum-check.
  let typeAttr = '';
  if (resolved === 'button') {
    const literal = lookupComponentAttr(node, ctx, 'type');
    typeAttr = isLiteralSafeForAttr(literal) ? ` type='${literal}'` : " type='   '";
  }
  const openTag = `<${resolved}${typeAttr}>`;
  const closeTag = `</${resolved}>`;
  const minLen = openTag.length + closeTag.length;
  const sourceLen = elementEnd - elementStart;
  if (sourceLen < minLen) {
    return false;
  }
  const inner = ' '.repeat(sourceLen - minLen);
  ctx.renames.push([elementStart, elementEnd, openTag + inner + closeTag]);
  ctx.fullyBlankedRanges.push([elementStart, elementEnd]);
  ctx.dynamicContentOffsets.push(elementStart);
  return true;
}

// Emit the rewrite plan for an attribute on a native (or substituted-as-
// native) element. Handles:
//
//   - Glimmer-only attrs (`@arg`, `...attributes`, `as`, `|x|`) — fully blanked.
//   - Concat-mustache values (`class='prefix-{{x}}'`) — blanked to `""<sp>"`,
//     yields DynamicValue via processAttribute; for boolean attrs, presence-only.
//   - Bare-mustache values (`id={{x}}`) — try static-text resolution; else
//     blanked to DynamicValue (or presence-only for boolean attrs).
function emitAttribute(attr: AST.AttrNode, ctx: Context, effectiveTag: string): void {
  const { blankRanges, fullyBlankedRanges, renames, scope, glintTypeMap } = ctx;

  if (isGlimmerOnlyAttr(attr.name)) {
    const r = rangeOf(attr);
    blankRanges.push(r);
    fullyBlankedRanges.push(r);
    return;
  }

  if (attr.value.type === 'ConcatStatement') {
    // Concat-mustache: literal portions mix with dynamic. Emit whole value
    // as `""<spaces>` to yield DynamicValue (loses validation of literal
    // portions but avoids false matches on partial literals).
    const valueStart = startOffset(attr.value);
    const valueEnd = endOffset(attr.value);
    const valueLen = valueEnd - valueStart;
    if (isBooleanAttr(effectiveTag, attr.name)) {
      const eqStart = valueStart - 1;
      blankRanges.push([eqStart, valueEnd]);
      fullyBlankedRanges.push([eqStart, valueEnd]);
    } else if (valueLen >= 2) {
      blankRanges.push([valueStart, valueEnd]);
      renames.push([valueStart, valueStart + 1, '"']);
      renames.push([valueEnd - 1, valueEnd, '"']);
      fullyBlankedRanges.push([valueStart, valueEnd]);
    } else {
      const r = rangeOf(attr);
      blankRanges.push(r);
      fullyBlankedRanges.push(r);
    }
    return;
  }

  if (attr.value.type === 'MustacheStatement') {
    // Bare-mustache attribute value. For boolean attrs, emit presence-only
    // (canonical "rendered" form per glimmer attribute coercion). For non-
    // boolean attrs, try static-text resolution (t-helper, if-helper, const,
    // Glint type) and embed if it fits; otherwise blank to DynamicValue.
    const valueStart = startOffset(attr.value);
    const valueEnd = endOffset(attr.value);
    const valueLen = valueEnd - valueStart;
    if (isBooleanAttr(effectiveTag, attr.name)) {
      const eqStart = valueStart - 1;
      blankRanges.push([eqStart, valueEnd]);
      fullyBlankedRanges.push([eqStart, valueEnd]);
    } else if (valueLen >= 2) {
      const resolved = tryStaticText(attr.value, scope, glintTypeMap, {
        attrTagName: effectiveTag,
        attrName: attr.name,
      });
      const innerLen = valueLen - 2;
      if (resolved !== null && resolved.length <= innerLen) {
        // Embed the resolved literal so html-validate sees the actual value
        // (enables enum validation). Shorter values appear with trailing
        // whitespace outside the closing quote.
        blankRanges.push([valueStart, valueEnd]);
        renames.push([valueStart, valueStart + 1, '"']);
        renames.push([valueStart + 1, valueStart + 1 + resolved.length, resolved]);
        renames.push([valueStart + 1 + resolved.length, valueStart + 2 + resolved.length, '"']);
        fullyBlankedRanges.push([valueStart, valueEnd]);
      } else {
        blankRanges.push([valueStart, valueEnd]);
        renames.push([valueStart, valueStart + 1, '"']);
        renames.push([valueEnd - 1, valueEnd, '"']);
        fullyBlankedRanges.push([valueStart, valueEnd]);
      }
    } else {
      const r = rangeOf(attr);
      blankRanges.push(r);
      fullyBlankedRanges.push(r);
    }
  }
}

// Handle an `<element>` AST node: drive Glint substitution / neutralization
// and process attributes / modifiers / inline comments.
function handleElementNode(node: AST.ElementNode, ctx: Context): void {
  const start = startOffset(node);
  if (ctx.inFullyBlankedRange(start)) {
    return;
  }

  // Glint substitution path. When it returns non-null, the element has
  // been handled (transparent, self-closing-substituted, or block-form
  // tag rename).
  //   - 'transparent': open/close blanked, return.
  //   - Non-void self-closing substitution (button, span, …): whole span
  //     is rewritten as <RESOLVED>...</RESOLVED>, skip attr processing.
  //   - Void self-closing substitution (input, img, br, …): only the
  //     tag-name was renamed; attrs still need blanking/preserving.
  //     Fall through to attribute processing.
  //   - Block-form: tag-name renamed in place; fall through to attribute
  //     processing.
  let effectiveTag = node.tag;
  const resolved = handleGlintSubstitution(node, ctx);
  if (resolved === 'transparent') {
    return;
  }
  if (resolved !== null) {
    effectiveTag = resolved;
    if (node.selfClosing && !VOID_ELEMENTS.has(resolved)) {
      // Non-void self-closing: the whole span is in fullyBlankedRanges;
      // attribute children are guarded out via inFullyBlankedRange.
      return;
    }
    // Void self-closing OR block-form: fall through to attr processing.
  }

  if (effectiveTag === node.tag && !isNativeTag(node.tag)) {
    // No Glint-resolved native equivalent — fall back to transparent
    // neutralization (open/close tags blanked; children float to parent).
    neutralizeComponent(node, ctx);
    return;
  }

  // Native element (or block-form Glint-substituted as native).
  if (elementHasDynamicContent(node)) {
    ctx.dynamicContentOffsets.push(start);
  }
  // For void natives whose required attrs can come from `...attributes`,
  // inject placeholders before the splat is blanked. Currently <img>; see
  // tryInjectImgRequiredAttrs for the rationale and scope.
  if (effectiveTag === 'img') {
    tryInjectImgRequiredAttrs(node, ctx);
  }
  for (const attr of node.attributes ?? []) {
    emitAttribute(attr, ctx, effectiveTag);
  }
  for (const modifier of node.modifiers ?? []) {
    const r = rangeOf(modifier);
    ctx.blankRanges.push(r);
    ctx.fullyBlankedRanges.push(r);
  }
  for (const comment of node.comments ?? []) {
    const r = rangeOf(comment);
    ctx.blankRanges.push(r);
    ctx.fullyBlankedRanges.push(r);
  }
}

// Handle a `{{mustache}}` AST node: try static-text resolution for embed,
// else blank.
function handleMustacheStatement(node: AST.MustacheStatement, ctx: Context): void {
  const { content, blankRanges, renames, scope, glintTypeMap } = ctx;
  const start = startOffset(node);
  if (ctx.inFullyBlankedRange(start)) {
    return;
  }
  const wholeStart = start;
  const wholeEnd = endOffset(node);
  const mustacheSrc = content.slice(wholeStart, wholeEnd);
  const text = tryStaticText(node, scope, glintTypeMap);
  // Skip embedding when the mustache spans multiple lines — overwriting
  // internal newlines would shift html-validate's line/column tracking
  // for everything after this point.
  const safeToEmbed = text !== null && text.length <= mustacheSrc.length && !/[\n\r]/u.test(mustacheSrc);
  if (safeToEmbed) {
    blankRanges.push([wholeStart, wholeEnd]);
    renames.push([wholeStart, wholeStart + text.length, text]);
  } else {
    blankRanges.push([wholeStart, wholeEnd]);
  }
}

// Handle a `{{!-- comment --}}` AST node. If it's an html-validate directive,
// rewrite as an HTML comment in place (length-preserved) so html-validate's
// parser sees the directive. Otherwise blank.
function handleMustacheCommentStatement(
  node: AST.MustacheCommentStatement,
  ctx: Context,
): void {
  const { content, blankRanges, renames } = ctx;
  const start = startOffset(node);
  if (ctx.inFullyBlankedRange(start)) {
    return;
  }
  const wholeStart = start;
  const wholeEnd = endOffset(node);
  const fullText = content.slice(wholeStart, wholeEnd);
  // `{{!--` (5 chars) → `<!-- ` (5 chars) and `--}}` (4 chars) → ` -->`
  // (4 chars) — same length, inner content untouched. Lets users write
  // directives without triggering `ember/template-no-html-comments`.
  //
  // The short form `{{! ... }}` is NOT supported: its markers are 5 chars
  // total, 2 chars shorter than `<!-- -->`, so we can't substitute in
  // place without changing length.
  if (
    /\[html-validate-(?:disable|enable)/.test(fullText) &&
    !/[\n\r]/.test(fullText) &&
    fullText.startsWith('{{!--') &&
    fullText.endsWith('--}}')
  ) {
    const newPrefix = '<!-- ';
    const newSuffix = ' -->';
    for (let i = 0; i < newPrefix.length; i++) {
      if (fullText[i] !== newPrefix[i]) {
        renames.push([wholeStart + i, wholeStart + i + 1, newPrefix[i]!]);
      }
    }
    const totalLen = wholeEnd - wholeStart;
    for (let i = 0; i < newSuffix.length; i++) {
      const idx = totalLen - newSuffix.length + i;
      if (fullText[idx] !== newSuffix[i]) {
        renames.push([wholeStart + idx, wholeStart + idx + 1, newSuffix[i]!]);
      }
    }
    return;
  }
  blankRanges.push(rangeOf(node));
}

// Handle a `{{#if}}/{{else}}/{{/if}}` (and `{{#each}}` / `{{#unless}}` /
// `{{#let}}`) AST node.
//
// Branch selection:
//   - When `ctx.branchSelections` has an entry for this block's start
//     offset (multipass driver), honor that choice.
//   - Otherwise, fall back to the form-submit-aware heuristic: emit the
//     program (truthy) branch by default, switch to the inverse only
//     when it's the only branch with a `<button type='submit'>`. Avoids
//     the most common single-branch FP (wcag/h32) without needing the
//     full multipass machinery.
function handleBlockStatement(node: AST.BlockStatement, ctx: Context): void {
  const { blankRanges, fullyBlankedRanges } = ctx;
  const wholeStart = startOffset(node);
  if (ctx.inFullyBlankedRange(wholeStart)) {
    return;
  }
  const programStart = startOffset(node.program);
  const programEnd = endOffset(node.program);
  const inverse = node.inverse;
  const wholeEnd = endOffset(node);

  if (!inverse) {
    blankRanges.push([wholeStart, programStart]);
    blankRanges.push([programEnd, wholeEnd]);
    return;
  }

  // Branch selection: caller-driven (multipass) or heuristic.
  let preferInverse: boolean;
  const explicit = ctx.branchSelections?.get(wholeStart);
  if (explicit !== undefined) {
    preferInverse = explicit === 'inverse';
  } else {
    const programHasSubmit = blockHasSubmitButton(node.program);
    const inverseHasSubmit = blockHasSubmitButton(inverse);
    preferInverse = inverseHasSubmit && !programHasSubmit;
  }

  if (preferInverse) {
    const inverseFirst = inverse.body[0]?.loc?.getStart().offset;
    const inverseLast = inverse.body[inverse.body.length - 1]?.loc?.getEnd().offset;
    if (typeof inverseFirst === 'number' && typeof inverseLast === 'number') {
      blankRanges.push([wholeStart, inverseFirst]);
      fullyBlankedRanges.push([wholeStart, inverseFirst]);
      blankRanges.push([inverseLast, wholeEnd]);
      fullyBlankedRanges.push([inverseLast, wholeEnd]);
      return;
    }
    // Fall through to default if we couldn't locate the inverse body.
  }

  // Default: emit program, blank inverse + closing marker.
  blankRanges.push([wholeStart, programStart]);
  blankRanges.push([programEnd, wholeEnd]);
  fullyBlankedRanges.push([programEnd, wholeEnd]);
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export interface BlankResult {
  content: string;
  error: Error | null;
  dynamicContentOffsets: number[];
}

export interface BlankErrorResult {
  content: string;
  error: Error;
  dynamicContentOffsets?: undefined;
}

function blankTemplateContent(
  content: string,
  scope?: ReadonlyMap<string, string>,
  glintTypeMap?: ReadonlyMap<string, AttrTypeInfo> | null,
  glintComponentTagMap?: ReadonlyMap<string, string> | null,
  glintComponentAttrMap?: ReadonlyMap<string, ComponentAttrs> | null,
  branchSelections?: ReadonlyMap<number, BranchChoice>,
): BlankResult | BlankErrorResult {
  // Pre-strip TS type annotations from block params so Glimmer's parser
  // accepts `{{#each items as |a: A, b: B|}}` and similar (it rejects
  // multi-param-with-types and complex types otherwise, silently
  // dropping the whole template). Length-preserving — AST offsets we
  // record below still match the original `content` string.
  const parseInput = stripBlockParamTypeAnnotations(content);
  let ast: AST.Template;
  try {
    // `mode: 'codemod'` preserves source-level distinctions we care about
    // (e.g. long-form `{{!-- ... --}}` vs short-form `{{! ... }}` comments;
    // exact whitespace) — same flag `ember-estree` uses for its
    // `templateOnly: true` path.
    ast = preprocess(parseInput, { mode: 'codemod' });
  } catch (err) {
    return { content, error: err instanceof Error ? err : new Error(String(err)) };
  }

  const ctx: Context = {
    content,
    scope,
    glintTypeMap,
    glintComponentTagMap,
    glintComponentAttrMap,
    blankRanges: [],
    renames: [],
    fullyBlankedRanges: [],
    dynamicContentOffsets: [],
    branchSelections,
    inFullyBlankedRange(offset: number): boolean {
      for (const [s, e] of ctx.fullyBlankedRanges) {
        if (offset >= s && offset < e) {
          return true;
        }
      }
      return false;
    },
  };

  traverse(ast, {
    ElementNode(node) {
      handleElementNode(node, ctx);
    },
    MustacheStatement(node) {
      handleMustacheStatement(node, ctx);
    },
    MustacheCommentStatement(node) {
      handleMustacheCommentStatement(node, ctx);
    },
    BlockStatement(node) {
      handleBlockStatement(node, ctx);
    },
  });

  // Apply the rewrite plan. Blank ranges first (everything overwritten
  // becomes spaces, except newlines which we preserve for line accounting),
  // then renames, which override blanks at overlapping positions.
  const buf = content.split('');

  ctx.blankRanges.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const [s, e] of ctx.blankRanges) {
    const last = merged[merged.length - 1];
    if (last && last[1] >= s) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  for (const [start, end] of merged) {
    for (let i = start; i < end && i < buf.length; i++) {
      if (buf[i] !== '\n' && buf[i] !== '\r') {
        buf[i] = ' ';
      }
    }
  }

  for (const [start, end, replacement] of ctx.renames) {
    if (replacement.length !== end - start) {
      continue;
    }
    for (let i = 0; i < replacement.length; i++) {
      buf[start + i] = replacement[i]!;
    }
  }

  return {
    content: buf.join(''),
    error: null,
    dynamicContentOffsets: ctx.dynamicContentOffsets,
  };
}

// True when the branch's body contains nothing the validator can see —
// only mustaches (`{{yield}}`, helpers, dynamic values), mustache
// comments, and whitespace. Selecting such a branch in multipass would
// emit a blanked DOM with no real children; presence-style rules
// (`wcag/h32` "form must have submit", `empty-heading`, `text-content`)
// then FP-fire because they don't know the runtime DOM might contain
// anything via the yield.
//
// Anything structural — native elements, component invocations, nested
// blocks — counts as real content and disqualifies the branch from
// "opaque-only".
function isBranchOpaqueOnly(branch: AST.Block): boolean {
  for (const stmt of branch.body) {
    if (stmt.type === 'TextNode') {
      if (stmt.chars.trim() !== '') return false;
      continue;
    }
    if (stmt.type === 'MustacheStatement' || stmt.type === 'MustacheCommentStatement') {
      continue;
    }
    return false;
  }
  return true;
}

// Multipass branch validation.
//
// Single-branch emission (`blankTemplateContent` without
// `branchSelections`) silently drops errors that live in unselected
// branches of a `{{#if}}/{{else}}` (or `{{else if}}` chain). Multipass
// fixes that by enumerating branch combinations and emitting one
// `BlankResult` per combination — each represents one possible runtime
// DOM. The caller (typically `transform.ts`) yields one html-validate
// `Source` per result so each combination is validated independently.
//
// Combinations are capped at maxConditionalBranches (count, not
// combinations) — templates with more conditional branches fall back
// to the first maxConditionalBranches in pre-order document order
// and ignore the rest. A "conditional branch" here is any block that
// has both a program and an `{{else}}` clause — `{{#if}}/{{else}}`,
// `{{#unless}}/{{else}}`, `{{#each}}/{{else}}` (empty fallback).
// Worst-case work is 2^maxConditionalBranches blanker calls when all
// branches are siblings; nested branches enumerate fewer combinations
// (see "Tree-aware enumeration" below).
//
// maxConditionalBranches defaults to 10 (worst case 2^10 = 1024
// blanker calls — cheap on real templates because nesting is more
// common than wide sibling lists, so tree-aware enumeration usually
// produces far fewer combinations). Override via the
// `HVE_MAX_CONDITIONAL_BRANCHES` env var. The env var is read
// per-call (not cached at module load) so flag-driven changes from
// the CLI take effect even when this module is imported eagerly.
// N=0 yields a single combination with no explicit selections,
// making multipass equivalent to the single-branch heuristic.
//
// Tree-aware enumeration: branches are organized into a tree where
// inner branches are children of the arm they're nested in. When a
// branch's program is selected, only its `programChildren` are
// enumerated; when its inverse is selected, only `inverseChildren`.
// The "blanked-out arm" is invisible to validation regardless of
// inner choices, so enumerating those choices would just produce
// duplicates that the dedupe collapses. Skipping them up front is
// strictly faster on nested templates: e.g. 6 branches chained
// down through `{{else}}` arms produces 7 combinations rather than
// 64.
//
// Identical outputs are still deduped via the `seen` Set — covers
// degenerate cases where two arms produce the same blanked text
// (e.g., both arms render `<div/>`).
//
// Trade-off vs single-pass: each yielded source is independently
// validated, so an error that's stable across branches (e.g., a
// misnested element OUTSIDE the if/else) gets reported once per
// combination. The caller may want to dedupe by (line, column,
// ruleId, message). Branch-internal errors land at distinct positions
// per branch and don't dedup.
function readMaxConditionalBranches(): number {
  const raw = process.env['HVE_MAX_CONDITIONAL_BRANCHES'];
  if (raw === undefined) return 10;
  // Strict integer parse — `parseInt` accepts partial numerics
  // (`"5abc"` → 5) which would silently change behavior on typos,
  // including accidentally disabling multipass when someone meant
  // to set a small cap (e.g. `"0abc"` → 0).
  if (!/^\d+$/.test(raw)) return 10;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : 10;
}
function blankTemplateContentMultipass(
  content: string,
  scope?: ReadonlyMap<string, string>,
  glintTypeMap?: ReadonlyMap<string, AttrTypeInfo> | null,
  glintComponentTagMap?: ReadonlyMap<string, string> | null,
  glintComponentAttrMap?: ReadonlyMap<string, ComponentAttrs> | null,
): Array<BlankResult | BlankErrorResult> {
  // Cap=0 disables multipass — the tree would be empty anyway, and
  // every fallback path below ends in a single `blankTemplateContent`
  // call. Short-circuit before the local `preprocess()` so the
  // disable path parses once instead of twice.
  const cap = readMaxConditionalBranches();
  if (cap === 0) {
    return [
      blankTemplateContent(content, scope, glintTypeMap, glintComponentTagMap, glintComponentAttrMap),
    ];
  }
  // Same pre-strip as `blankTemplateContent` — see that function's
  // comment for rationale. We need the strip here too because we walk
  // the AST locally to enumerate branch points before delegating each
  // combination to `blankTemplateContent` (which strips again on its
  // own — idempotent since the strip is length-preserving and a second
  // pass finds nothing left to strip).
  const parseInput = stripBlockParamTypeAnnotations(content);
  let ast: AST.Template;
  try {
    ast = preprocess(parseInput, { mode: 'codemod' });
  } catch (err) {
    return [{ content, error: err instanceof Error ? err : new Error(String(err)) }];
  }

  // Collect conditional branches as a tree, preserving nesting. A
  // conditional branch is any `BlockStatement` with both a program
  // and an inverse (`{{#if/else}}`, `{{#unless/else}}`,
  // `{{#each/else}}`). Children of a branch are split by the arm
  // they live in: `programChildren` if nested in the program arm,
  // `inverseChildren` if nested in the inverse arm. The enumerator
  // below uses this split to skip enumerating an arm's nested
  // branches when that arm is blanked — i.e., when the *other* arm
  // is selected. Those nested choices can't influence the blanked
  // output, so enumerating them would just produce duplicates that
  // the `seen` dedupe later collapses. For deeply-nested templates
  // this turns exponential waste into a single pass per reachable
  // runtime DOM.
  //
  // The cap is on total branch count in pre-order document order —
  // surplus branches don't appear in the tree at all and the
  // form-submit-aware single-branch heuristic decides for them.
  // Opaque-only arms are recorded so the enumerator can skip them
  // (avoids presence-style FPs).
  interface ConditionalBranch {
    offset: number;
    opaqueProgram: boolean;
    opaqueInverse: boolean;
    programChildren: ConditionalBranch[];
    inverseChildren: ConditionalBranch[];
  }
  let included = 0;

  function collect(
    nodes: ReadonlyArray<AST.Statement | AST.TopLevelStatement>,
    out: ConditionalBranch[],
  ): void {
    for (const node of nodes) {
      if (included >= cap) return;
      if (node.type === 'BlockStatement') {
        if (node.inverse) {
          included++;
          const branch: ConditionalBranch = {
            offset: startOffset(node),
            opaqueProgram: isBranchOpaqueOnly(node.program),
            opaqueInverse: isBranchOpaqueOnly(node.inverse),
            programChildren: [],
            inverseChildren: [],
          };
          collect(node.program.body, branch.programChildren);
          collect(node.inverse.body, branch.inverseChildren);
          out.push(branch);
        } else {
          // Non-branching block (`{{#each}}` without `{{else}}`,
          // `{{#let}}`, etc.) — its body may contain branches, but
          // they belong to the current arm.
          collect(node.program.body, out);
        }
      } else if (node.type === 'ElementNode') {
        collect(node.children, out);
      }
    }
  }

  const tree: ConditionalBranch[] = [];
  collect(ast.body, tree);

  if (tree.length === 0) {
    return [
      blankTemplateContent(content, scope, glintTypeMap, glintComponentTagMap, glintComponentAttrMap),
    ];
  }

  // Tree-aware enumeration: for each sibling list, take the cross
  // product of (this branch's reachable sub-combinations) × (the
  // remaining siblings' enumerations). Choosing `program` for a
  // branch unlocks its `programChildren`; choosing `inverse` unlocks
  // its `inverseChildren`. Opaque-only arms are skipped — and if
  // both arms are opaque the branch contributes nothing, leaving
  // its parent enumeration empty for that path.
  //
  // Subtlety: if a non-opaque arm's child enumeration yields no
  // combinations (e.g., the arm contains a nested branch whose
  // both arms are opaque-only), we still need to emit the outer
  // arm — its non-nested DOM content (`<div>X</div>` outside the
  // nested if/else) is reachable at runtime and must be validated.
  // The nested branch then falls to the single-branch heuristic
  // inside `blankTemplateContent`. Without this fall-through, the
  // outer.program selection would silently disappear and any DOM
  // outside the nested if/else would be permanently blanked.
  function* enumerate(
    siblings: ReadonlyArray<ConditionalBranch>,
  ): Iterable<ReadonlyMap<number, BranchChoice>> {
    if (siblings.length === 0) {
      yield new Map();
      return;
    }
    const first = siblings[0]!;
    const rest = siblings.slice(1);
    for (const restSel of enumerate(rest)) {
      if (!first.opaqueProgram) {
        let yielded = false;
        for (const innerSel of enumerate(first.programChildren)) {
          yielded = true;
          const sel = new Map<number, BranchChoice>(restSel);
          sel.set(first.offset, 'program');
          for (const [k, v] of innerSel) sel.set(k, v);
          yield sel;
        }
        if (!yielded) {
          const sel = new Map<number, BranchChoice>(restSel);
          sel.set(first.offset, 'program');
          yield sel;
        }
      }
      if (!first.opaqueInverse) {
        let yielded = false;
        for (const innerSel of enumerate(first.inverseChildren)) {
          yielded = true;
          const sel = new Map<number, BranchChoice>(restSel);
          sel.set(first.offset, 'inverse');
          for (const [k, v] of innerSel) sel.set(k, v);
          yield sel;
        }
        if (!yielded) {
          const sel = new Map<number, BranchChoice>(restSel);
          sel.set(first.offset, 'inverse');
          yield sel;
        }
      }
    }
  }

  const results: Array<BlankResult | BlankErrorResult> = [];
  const seen = new Set<string>();

  for (const selections of enumerate(tree)) {
    const result = blankTemplateContent(
      content,
      scope,
      glintTypeMap,
      glintComponentTagMap,
      glintComponentAttrMap,
      selections,
    );
    if (result.error) {
      // Parse failure is the same for every combination — no point
      // running the rest.
      return [result];
    }
    if (!seen.has(result.content)) {
      seen.add(result.content);
      results.push(result);
    }
  }

  // Every combination selected at least one opaque-only branch — fall
  // back to a single heuristic-driven pass so we still validate the
  // template's stable (outside-of-branch) content.
  if (results.length === 0) {
    return [
      blankTemplateContent(content, scope, glintTypeMap, glintComponentTagMap, glintComponentAttrMap),
    ];
  }

  return results;
}

export { blankTemplateContent, blankTemplateContentMultipass, isNativeTag };
