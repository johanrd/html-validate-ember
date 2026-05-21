// Canonical resolver: a component template AST + consumer args → Resolution.
//
// One function with a clear contract. Replaces the scattered logic in:
//   - lib/glint.ts:resolveOuterWrapperTag (dead after rewrite)
//   - lib/glint.ts:chooseSubstitutionFromResolution (dead)
//   - lib/component-attrs.ts:extractSplattedRoot (kept for now, will fold)
//   - lib/component-attrs.ts:detectPolymorphicTag (folded into here)
//   - lib/component-attrs.ts:getPolymorphicResolvedTag (folded)
//   - lib/outer-wrapper-resolver.ts:resolveOuterWrapper* (dead)
//
// Algorithm (one path, ordered):
//   1. Outer ElementNode is a native HTML tag → return that tag + attrs +
//      yield-ancestor (where {{yield}} sits, if a different native ancestor).
//   2. Outer is `{{#let (element X) as |Tag|}}<Tag>…</Tag>{{/let}}` →
//      trace X (literal | @arg propagation | this.prop via class getter).
//   3. Outer is a PascalCase wrapper → recurse into its template.
//   4. Outer is a conditional ({{#if}}, {{#unless}}) → resolve all
//      branches; converge or transparent.
//   5. Anything else → transparent.
//
// Public Resolution is the SINGLE answer. Callers don't make a "dual-tag"
// choice — the resolver picks the right tag (preferring the yield-ancestor
// when content-permission validation hinges on it).

import { preprocess, type AST } from '@glimmer/syntax';
import { Preprocessor } from 'content-tag';
import type * as TS from 'typescript';
import path from 'node:path';
import fs from 'node:fs';

import { STRUCTURAL_CHILD_TAGS } from '../element-sets.js';

function parseTemplate(content: string): AST.Template {
  return preprocess(content, { mode: 'codemod' });
}

const ctPreprocessor = new Preprocessor();

function stripTemplateBlocks(contents: string, filename: string): string {
  let blocks: ReturnType<Preprocessor['parse']>;
  try {
    blocks = ctPreprocessor.parse(contents, { filename });
  } catch {
    return contents;
  }
  let buf = contents;
  for (const block of [...blocks].reverse()) {
    if (block.tagName !== 'template') continue;
    if (!block.range) continue;
    const start = block.range.startUtf16Codepoint;
    const end = block.range.endUtf16Codepoint;
    buf = buf.slice(0, start) + ' '.repeat(end - start) + buf.slice(end);
  }
  return buf;
}

import {
  findTemplateSource,
  resolveImport,
  type TemplateSource,
} from './template-source.js';

// --- public types --------------------------------------------------------

export interface TagResolution {
  kind: 'tag';
  tag: string;
  attrs: Map<string, string>;
  hasSplat: boolean;
  yieldAncestorTag?: string;
  yieldAncestorAttrs?: Map<string, string>;
}

export interface TransparentResolution {
  kind: 'transparent';
}

export type Resolution = TagResolution | TransparentResolution;

export interface ResolveOptions {
  /** Args the consumer passed to this component, e.g. {tag: 'li', size: 'sm'}. */
  consumerArgs?: ReadonlyMap<string, string>;
  /** TypeScript module — for inspecting class getters that drive (element this.prop). */
  ts?: typeof TS | null;
  /** Visited set + depth — cycle/recursion guard for cross-component recursion. */
  visited?: Set<string>;
  depth?: number;
}

// The substitution a resolved component invocation should blank to:
// which native tag, with which literal attrs, whether `...attributes`
// splats onto it, and whether the tag came from the yield-ancestor
// rather than the outer wrapper.
export interface ChosenSubstitution {
  tag: string;
  attrs: Map<string, string>;
  hasSplat: boolean;
  fromYieldAncestor: boolean;
}

// Pick the substitution tag for a resolved component invocation.
//
// Prefer the yield-ancestor over the outer wrapper when content-
// permission validation hinges on it: a component whose template is
// `<nav><ol>{{yield}}</ol></nav>` must substitute as `<ol>`, because
// consumer-yielded `<li>` items land inside the `<ol>` at runtime —
// substituting the outer `<nav>` would FP-fire element-permitted-content
// / element-permitted-parent on the `<li>` (issue #33).
//
// Guards (mirrors the no-op cases this preference must NOT regress):
//   - the yield-ancestor differs from the outer tag;
//   - neither the outer nor the yield-ancestor is a structural child
//     (`<li>`, `<td>`, `<legend>`, …) — those only make sense under a
//     specific parent, so substituting one at the call site
//     reintroduces the very element-permitted-parent FPs this
//     preference is meant to suppress;
//   - the yield-ancestor is a native tag.
//
// When the preference applies, consumer `...attributes` still splat
// onto the OUTER wrapper at runtime, not the yield-ancestor — callers
// use `fromYieldAncestor` to strip ARIA attrs off the substituted tag
// (see `ComponentAttrs.fromYieldAncestor`).
//
// Shared by BOTH resolution-map builders — `applyResolution` (the
// Glint path, lib/glint.ts) and `buildResolutionMaps` (the canonical-
// resolver path, lib/resolver/build-maps.ts) — so the two can't
// diverge on this again (issue #33 was exactly that divergence: only
// the Glint path applied the preference).
export function chooseSubstitution(resolution: TagResolution): ChosenSubstitution {
  const yieldTag = resolution.yieldAncestorTag;
  if (
    yieldTag &&
    yieldTag !== resolution.tag &&
    !STRUCTURAL_CHILD_TAGS.has(resolution.tag) &&
    !STRUCTURAL_CHILD_TAGS.has(yieldTag) &&
    isNativeTagName(yieldTag)
  ) {
    return {
      tag: yieldTag,
      attrs: resolution.yieldAncestorAttrs ?? new Map(),
      hasSplat: true,
      fromYieldAncestor: true,
    };
  }
  return {
    tag: resolution.tag,
    attrs: resolution.attrs,
    hasSplat: resolution.hasSplat,
    fromYieldAncestor: false,
  };
}

const TRANSPARENT: TransparentResolution = { kind: 'transparent' };
const MAX_DEPTH = 10;

// --- entry point ---------------------------------------------------------

export function resolveTemplate(source: TemplateSource, options: ResolveOptions = {}): Resolution {
  let ast: AST.Template;
  try {
    ast = parseTemplate(source.content);
  } catch {
    return TRANSPARENT;
  }
  return resolveBody(ast.body, source, options);
}

// --- body walking --------------------------------------------------------

function resolveBody(
  body: ReadonlyArray<AST.Statement>,
  source: TemplateSource,
  options: ResolveOptions,
): Resolution {
  const elementProducers = body.filter(isElementProducer);
  if (elementProducers.length !== 1) return TRANSPARENT;
  return resolveStatement(elementProducers[0]!, source, options);
}

function isElementProducer(stmt: AST.Statement): boolean {
  if (stmt.type === 'TextNode') return /\S/.test(stmt.chars);
  if (stmt.type === 'CommentStatement' || stmt.type === 'MustacheCommentStatement') return false;
  if (stmt.type === 'MustacheStatement') {
    // {{yield}} alone doesn't produce an element on the outer side.
    const path = stmt.path;
    if (path.type === 'PathExpression' && path.original === 'yield') return false;
    // A bare mustache could resolve to anything; treat as element-producer
    // so multi-mustache templates bail to transparent.
    return true;
  }
  return stmt.type === 'ElementNode' || stmt.type === 'BlockStatement';
}

function resolveStatement(
  stmt: AST.Statement,
  source: TemplateSource,
  options: ResolveOptions,
): Resolution {
  if (stmt.type === 'ElementNode') return resolveElement(stmt, source, options);
  if (stmt.type === 'BlockStatement') {
    if (isElementHelperLet(stmt)) return resolveElementHelperLet(stmt, source, options);
    if (isConditional(stmt)) return resolveConditional(stmt, source, options);
    if (isPassthroughBlock(stmt)) return resolveBody(stmt.program.body, source, options);
  }
  return TRANSPARENT;
}

// --- element resolution --------------------------------------------------

function resolveElement(
  node: AST.ElementNode,
  source: TemplateSource,
  options: ResolveOptions,
): Resolution {
  // Native HTML element → done.
  if (isNativeTagName(node.tag)) {
    return makeNativeResolution(node, source, options);
  }

  // PascalCase wrapper → recurse.
  if (isResolvableWrapperTag(node.tag)) {
    const resolution = resolvePascalRecursion(node, source, options);
    if (resolution.kind !== 'transparent') return resolution;
    // Pure-yield wrappers (template body is `{{yield (...)}}` only,
    // no element of their own — HDS HdsPopoverPrimitive shape) emit
    // the consumer's CHILDREN directly into the rendered DOM. The
    // invocation's body in THIS template is what actually wraps; walk
    // it for a real outer tag. Without this, HdsDropdown (whose
    // template's outer is `<HdsPopoverPrimitive as |PP|>{<div>…
    // <ul>{{yield (hash Interactive=…)}}</ul>…</div>}</HdsPopoverPrimitive>`)
    // resolves to transparent, the substitution drops its `<div>`
    // wrapper, and the yielded `<li>` items appear as siblings of
    // the consumer's outer `<li>`.
    const wrapperSource = findPascalWrapperSource(node, source, options);
    if (wrapperSource && isPureYieldWrapper(wrapperSource)) {
      const descended = resolveBody(node.children, source, options);
      if (descended.kind !== 'transparent') return descended;
    }
    return resolution;
  }

  // Dotted (`<This.Foo>`, `<F.Item>`) — yield-binding or curried path.
  // We don't statically resolve these; transparent is the safe answer.
  return TRANSPARENT;
}

// Locate the TemplateSource for a PascalCase wrapper. Mirrors the
// import/by-name/sibling probe order in `resolvePascalRecursion` so
// `resolveElement`'s pure-yield descent has access to the same
// resolved source without re-walking through `resolvePascalRecursion`.
function findPascalWrapperSource(
  node: AST.ElementNode,
  source: TemplateSource,
  options: ResolveOptions,
): TemplateSource | null {
  const importedFile = resolveImport(source.origin, node.tag, options.ts ?? null);
  if (importedFile) {
    const importedSource = findTemplateSource({ declFile: importedFile, ts: options.ts });
    if (importedSource) return importedSource;
  }
  const byName = findTemplateSource({
    consumerFile: source.origin,
    componentName: node.tag,
    ts: options.ts,
  });
  if (byName) return byName;
  return trySiblingProbe(source.origin, node.tag);
}

// A wrapper is "pure-yield" when its template body has no element-
// producers of its own — just `{{yield (...)}}` statements (and
// whitespace / mustache comments). The consumer's children fully
// describe the rendered DOM in that case.
function isPureYieldWrapper(wrapperSource: TemplateSource): boolean {
  let ast: AST.Template;
  try {
    ast = parseTemplate(wrapperSource.content);
  } catch {
    return false;
  }
  let hasYield = false;
  for (const node of ast.body) {
    if (isElementProducer(node)) return false;
    if (
      node.type === 'MustacheStatement'
      && node.path.type === 'PathExpression'
      && node.path.original === 'yield'
    ) {
      hasYield = true;
    }
  }
  return hasYield;
}

function makeNativeResolution(
  node: AST.ElementNode,
  _source: TemplateSource,
  _options: ResolveOptions,
): TagResolution {
  const attrs = extractLiteralAttrs(node);
  const hasSplat = node.attributes.some((a) => a.name === '...attributes');
  const yieldAncestor = findYieldAncestor(node);
  const result: TagResolution = { kind: 'tag', tag: node.tag, attrs, hasSplat };
  if (yieldAncestor && yieldAncestor !== node) {
    result.yieldAncestorTag = yieldAncestor.tag;
    result.yieldAncestorAttrs = extractLiteralAttrs(yieldAncestor);
  }
  return result;
}

// DynamicValue placeholder: a 3-space sentinel injected for arg-bound
// or concat-mustache attribute values. The blanker recognizes it via
// `isDynamicValuePlaceholder` (lib/dynamic-value.ts) and converts to
// DynamicValue, so html-validate sees the attribute as present even
// when its concrete value is computed at runtime (e.g.
// `<iframe title={{@label}}>` — title is required and dynamic).
const DYNAMIC_VALUE_PLACEHOLDER = '   ';

function extractLiteralAttrs(node: AST.ElementNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const attr of node.attributes) {
    if (attr.name === '...attributes') continue;
    if (attr.name.startsWith('@')) continue;
    if (attr.value.type === 'TextNode') {
      out.set(attr.name, attr.value.chars);
    } else if (
      attr.value.type === 'MustacheStatement' ||
      attr.value.type === 'ConcatStatement'
    ) {
      out.set(attr.name, DYNAMIC_VALUE_PLACEHOLDER);
    }
  }
  return out;
}

// --- yield-ancestor walk -------------------------------------------------
//
// Find the nearest ElementNode ancestor of {{yield}} in the template.
// Used for content-permission validation: when consumer puts content
// inside the component, that content lands inside the yield-ancestor at
// runtime. e.g., `<HdsTabs>` whose template is
// `<div>...<ul>{{yield}}</ul>...</div>` has yield-ancestor `<ul>`, so
// consumer-yielded `<li>` items are valid even though the outer is
// `<div>`.

function findYieldAncestor(root: AST.ElementNode): AST.ElementNode | null {
  // Collect every {{yield}}'s nearest native ancestor. When all yields
  // share the same ancestor, return it (consumer-yielded content has
  // a single landing site). When yields go to different ancestors
  // (e.g. multi-yield-to=head/body templates with `<thead>` and
  // `<tbody>` ancestors), return null — there's no single answer,
  // and the caller should fall back to the outer wrapper.
  const ancestors: AST.ElementNode[] = [];
  function walk(node: AST.Node, ancestor: AST.ElementNode | null): void {
    if (node.type === 'ElementNode') {
      for (const child of node.children) walk(child, node);
      return;
    }
    if (
      node.type === 'MustacheStatement' &&
      node.path.type === 'PathExpression' &&
      node.path.original === 'yield' &&
      ancestor
    ) {
      ancestors.push(ancestor);
      return;
    }
    if (node.type === 'BlockStatement') {
      for (const child of node.program.body) walk(child, ancestor);
      if (node.inverse) {
        for (const child of node.inverse.body) walk(child, ancestor);
      }
    }
  }
  for (const child of root.children) walk(child, root);
  if (ancestors.length === 0) return null;
  const first = ancestors[0]!;
  for (const a of ancestors) {
    if (a !== first) return null;
  }
  return first;
}

// --- (element X) helper inside {{#let}} ----------------------------------
//
// Pattern: `{{#let (element X) as |Tag|}}<Tag ...>{{yield}}</Tag>{{/let}}`
// X can be:
//   - String literal: `(element "li")` → tag = "li"
//   - @arg passthrough: `(element @tag)` → tag = consumerArgs.get('tag') or transparent
//   - this.prop: `(element this.componentTag)` → walk the class getter

function isElementHelperLet(stmt: AST.BlockStatement): boolean {
  if (stmt.path.type !== 'PathExpression') return false;
  if (stmt.path.original !== 'let') return false;
  if (stmt.params.length !== 1) return false;
  const first = stmt.params[0];
  if (!first || first.type !== 'SubExpression') return false;
  return first.path.type === 'PathExpression' && first.path.original === 'element';
}

function resolveElementHelperLet(
  stmt: AST.BlockStatement,
  source: TemplateSource,
  options: ResolveOptions,
): Resolution {
  const elementCall = stmt.params[0] as AST.SubExpression;
  const tagSpec = elementCall.params[0];
  if (!tagSpec) return TRANSPARENT;

  const tag = resolveTagSpec(tagSpec, source, options);
  if (tag === null) return TRANSPARENT;

  // The let-block body uses |Tag| as the resolved tag. We treat the
  // pattern as if the outer were `<Tag>` and continue with content
  // inside. Find the inner `<Tag>` element within the block program
  // to harvest attrs + yield-ancestor.
  const tagBinding = stmt.program.blockParams[0];
  const innerTag = tagBinding ? findInnerElementByName(stmt.program.body, tagBinding) : null;
  const attrs = innerTag ? extractLiteralAttrs(innerTag) : new Map<string, string>();
  // When the let-block body doesn't actually invoke `<Tag>` we have
  // no element to harvest splat from; defaulting to `true` would
  // incorrectly project consumer attributes onto a resolution that
  // isn't backed by a splatted element. The conservative default
  // is `false`.
  const hasSplat = innerTag ? innerTag.attributes.some((a) => a.name === '...attributes') : false;
  const result: TagResolution = { kind: 'tag', tag, attrs, hasSplat };
  // Yield-ancestor inside the inner tag (rare but possible).
  if (innerTag) {
    const ya = findYieldAncestor(innerTag);
    if (ya && ya !== innerTag) {
      result.yieldAncestorTag = ya.tag;
      result.yieldAncestorAttrs = extractLiteralAttrs(ya);
    }
  }
  return result;
}

function findInnerElementByName(
  body: ReadonlyArray<AST.Statement>,
  name: string,
): AST.ElementNode | null {
  for (const stmt of body) {
    if (stmt.type === 'ElementNode' && stmt.tag === name) return stmt;
    if (stmt.type === 'BlockStatement') {
      const inner = findInnerElementByName(stmt.program.body, name);
      if (inner) return inner;
    }
  }
  return null;
}

// Resolve a tag-spec (the first arg to (element ...)) to a literal string.
// Returns null when transparent (couldn't pin).
function resolveTagSpec(
  expr: AST.Expression,
  source: TemplateSource,
  options: ResolveOptions,
): string | null {
  if (expr.type === 'StringLiteral') return expr.value;
  if (expr.type === 'PathExpression') {
    if (expr.head?.type === 'AtHead') {
      // (element @tag) — look up consumer's @tag value.
      const argName = expr.head.name.replace(/^@/, '');
      const value = options.consumerArgs?.get(argName);
      return value ?? null;
    }
    if (expr.head?.type === 'ThisHead') {
      // (element this.prop) — walk class getter for the prop.
      const propName = expr.tail[0];
      if (!propName || !options.ts) return null;
      const propResolution = resolveThisProp(source, propName, options);
      return propResolution;
    }
  }
  return null;
}

// Walk the class declaration in `source.origin` for a getter named
// `propName`. Recognized patterns:
//   get componentTag(): T {
//     const { argName = 'default' } = this.args;
//     return argName;
//   }
// → resolves to consumerArgs.get('argName') ?? 'default'
//
//   get componentTag(): T { return 'literal'; }
// → resolves to 'literal'.
export function resolveThisProp(
  source: TemplateSource,
  propName: string,
  options: ResolveOptions,
): string | null {
  const ts = options.ts;
  if (!ts) return null;
  const parsed = readClassBody(source.origin, ts);
  if (!parsed) return null;
  const { classBody, topLevelConsts, enumsByName } = parsed;

  for (const member of classBody) {
    if (!ts.isGetAccessor(member)) continue;
    if (!ts.isIdentifier(member.name) || member.name.text !== propName) continue;
    return analyzeGetterBody(
      ts,
      member.body,
      options.consumerArgs ?? new Map(),
      topLevelConsts,
      enumsByName,
    );
  }
  return null;
}

interface ParsedClassFile {
  classBody: TS.NodeArray<TS.ClassElement>;
  /** Map from a file-level `const X = '<literal>';` name to its value.
   *  Used to resolve identifier-valued destructure defaults like
   *  `const { tag = DEFAULT_TAG } = this.args;` where `DEFAULT_TAG`
   *  points to a top-level `const DEFAULT_TAG = 'div';`. */
  topLevelConsts: Map<string, string>;
  /** Map from enum name → member name → string value. Lets the getter
   *  walker resolve `EnumName.Member` PropertyAccess inside the body
   *  (e.g. `return this.args.X ?? EnumName.Member;`) without
   *  pre-flattening it through a const indirection. */
  enumsByName: Map<string, Map<string, string>>;
}

function readClassBody(origin: string, ts: typeof TS): ParsedClassFile | null {
  let contents: string;
  try {
    contents = fs.readFileSync(origin, 'utf8');
  } catch {
    return null;
  }
  // .gts / .gjs files have `<template>...</template>` blocks that TS's
  // parser interprets as JSX and fails on (`<template>` looks like a
  // JSX element open). Strip the blocks to whitespace before parsing
  // so the class declaration around them parses cleanly.
  if (origin.endsWith('.gts') || origin.endsWith('.gjs')) {
    contents = stripTemplateBlocks(contents, origin);
  }
  const sf = ts.createSourceFile(
    origin,
    contents,
    ts.ScriptTarget.Latest,
    false,
    origin.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  let classBody: TS.NodeArray<TS.ClassElement> | null = null;

  // Build a map of enum name → member-name → string value. Captures
  // enums declared in this file. HDS components also import their tag
  // enums from a sibling `types.ts`; for those we follow the import
  // path (relative only) and parse the target file's enums.
  const enumsByName = new Map<string, Map<string, string>>();
  function captureEnums(file: TS.SourceFile): Map<string, Map<string, string>> {
    const out = new Map<string, Map<string, string>>();
    for (const stmt of file.statements) {
      if (!ts.isEnumDeclaration(stmt)) continue;
      const members = new Map<string, string>();
      for (const member of stmt.members) {
        if (!member.initializer) continue;
        if (!ts.isStringLiteral(member.initializer)) continue;
        const memberName = ts.isIdentifier(member.name) ? member.name.text
          : ts.isStringLiteral(member.name) ? member.name.text : null;
        if (memberName === null) continue;
        members.set(memberName, member.initializer.text);
      }
      if (members.size > 0) out.set(stmt.name.text, members);
    }
    return out;
  }
  for (const [name, members] of captureEnums(sf)) enumsByName.set(name, members);

  // Follow relative imports (`./foo.ts`, `./foo`) for enums named in
  // `import { EnumName } from '...'`. Resolution is shallow — we don't
  // chain through re-exports.
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith('.')) continue;
    const importClause = stmt.importClause;
    if (!importClause?.namedBindings || !ts.isNamedImports(importClause.namedBindings)) continue;
    const wantedNames = new Set<string>();
    for (const elem of importClause.namedBindings.elements) {
      wantedNames.add((elem.propertyName ?? elem.name).text);
    }
    // Resolve the relative path, trying common extensions.
    const dir = path.dirname(origin);
    const candidates = [spec, spec + '.ts', spec + '.tsx'];
    let resolvedPath: string | null = null;
    for (const c of candidates) {
      const full = path.resolve(dir, c);
      if (fs.existsSync(full)) { resolvedPath = full; break; }
    }
    if (!resolvedPath) continue;
    let importContents: string;
    try { importContents = fs.readFileSync(resolvedPath, 'utf8'); } catch { continue; }
    const importSf = ts.createSourceFile(resolvedPath, importContents, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    for (const [name, members] of captureEnums(importSf)) {
      if (wantedNames.has(name) && !enumsByName.has(name)) {
        enumsByName.set(name, members);
      }
    }
  }

  // Resolve a const initializer expression to a string literal when
  // possible. Handles StringLiteral and `EnumName.Member` lookups.
  function resolveConstInit(expr: TS.Expression): string | null {
    if (ts.isStringLiteral(expr)) return expr.text;
    if (
      ts.isPropertyAccessExpression(expr)
      && ts.isIdentifier(expr.expression)
      && ts.isIdentifier(expr.name)
    ) {
      const members = enumsByName.get(expr.expression.text);
      if (members) return members.get(expr.name.text) ?? null;
    }
    return null;
  }

  const topLevelConsts = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const v = resolveConstInit(decl.initializer);
        if (v !== null) topLevelConsts.set(decl.name.text, v);
      }
    }
  }
  function visit(node: TS.Node): void {
    if (classBody) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      classBody = node.members;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return classBody ? { classBody, topLevelConsts, enumsByName } : null;
}

function analyzeGetterBody(
  ts: typeof TS,
  body: TS.Block | undefined,
  consumerArgs: ReadonlyMap<string, string>,
  topLevelConsts: ReadonlyMap<string, string>,
  enumsByName: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | null {
  if (!body) return null;
  // Walk for VariableStatement that destructures from `this.args`,
  // followed by `return <varName>`. Also handles
  // `return this.args.X ?? Default;` directly.
  const destructureDefaults = new Map<string, string>();

  // Resolve an Expression to a string literal value when possible.
  // Handles StringLiteral, Identifier (via topLevelConsts), and
  // `EnumName.Member` PropertyAccess (via enumsByName) — the latter
  // covers HDS dialog-primitive's
  // `return this.args.X ?? HdsXxxValues.Div;` shape directly,
  // without requiring the addon to also alias the enum member
  // through a top-level const.
  function exprToLiteral(expr: TS.Expression): string | null {
    if (ts.isStringLiteral(expr)) return expr.text;
    if (ts.isIdentifier(expr)) return topLevelConsts.get(expr.text) ?? null;
    if (
      ts.isPropertyAccessExpression(expr)
      && ts.isIdentifier(expr.expression)
      && ts.isIdentifier(expr.name)
    ) {
      const members = enumsByName.get(expr.expression.text);
      if (members) return members.get(expr.name.text) ?? null;
    }
    return null;
  }

  for (const stmt of body.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.initializer) continue;
        if (!isThisArgs(ts, decl.initializer)) continue;
        if (!ts.isObjectBindingPattern(decl.name)) continue;
        for (const elem of decl.name.elements) {
          if (!ts.isIdentifier(elem.name)) continue;
          const argName = elem.propertyName && ts.isIdentifier(elem.propertyName)
            ? elem.propertyName.text
            : elem.name.text;
          let defaultVal: string | null = null;
          if (elem.initializer) {
            defaultVal = exprToLiteral(elem.initializer);
          }
          // Track local-binding name → (argName, default).
          destructureDefaults.set(elem.name.text, argName);
          // Also track default value for arg-name lookup later.
          if (defaultVal !== null && !consumerArgs.has(argName)) {
            destructureDefaults.set(`__default_${elem.name.text}`, defaultVal);
          }
        }
      }
    }
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      if (ts.isStringLiteral(stmt.expression)) return stmt.expression.text;
      if (ts.isIdentifier(stmt.expression)) {
        const localName = stmt.expression.text;
        const argName = destructureDefaults.get(localName);
        if (argName) {
          const consumerVal = consumerArgs.get(argName);
          if (consumerVal !== undefined) return consumerVal;
          const def = destructureDefaults.get(`__default_${localName}`);
          if (def !== undefined) return def;
          return null;
        }
        // Bare top-level const reference: `return DEFAULT_TAG;`.
        const directConst = topLevelConsts.get(localName);
        if (directConst !== undefined) return directConst;
      }
      // `return this.args.X ?? Default;` — direct binary form (no
      // intermediate destructure). Used by HDS dialog-primitive's
      // `get titleTag() { return this.args.titleTag ?? DEFAULT; }`.
      if (
        ts.isBinaryExpression(stmt.expression)
        && stmt.expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        const lhs = stmt.expression.left;
        // `this.args.X`
        if (
          ts.isPropertyAccessExpression(lhs)
          && ts.isPropertyAccessExpression(lhs.expression)
          && lhs.expression.expression.kind === ts.SyntaxKind.ThisKeyword
          && ts.isIdentifier(lhs.expression.name)
          && lhs.expression.name.text === 'args'
          && ts.isIdentifier(lhs.name)
        ) {
          const argName = lhs.name.text;
          const consumerVal = consumerArgs.get(argName);
          if (consumerVal !== undefined) return consumerVal;
          return exprToLiteral(stmt.expression.right);
        }
      }
    }
  }
  return null;
}

function isThisArgs(ts: typeof TS, expr: TS.Expression): boolean {
  return ts.isPropertyAccessExpression(expr)
    && expr.expression.kind === ts.SyntaxKind.ThisKeyword
    && ts.isIdentifier(expr.name)
    && expr.name.text === 'args';
}

// --- PascalCase wrapper recursion ----------------------------------------
//
// `<Outer @tag="li">{{yield}}</Outer>` — Outer's template determines our
// runtime tag. Recurse: resolve Outer's template with our consumerArgs +
// the @args we pass to Outer.

function resolvePascalRecursion(
  node: AST.ElementNode,
  source: TemplateSource,
  options: ResolveOptions,
): Resolution {
  const visited = options.visited ?? new Set();
  const depth = options.depth ?? 0;
  if (depth >= MAX_DEPTH) return TRANSPARENT;

  // Resolution order:
  //   1. Follow `import Foo from '...'` in the origin file. This handles
  //      cross-package wrappers (`<PolyText>` imported into PolyListItem)
  //      and same-package relative imports.
  //   2. v1-addon by-name lookup (`.hbs` consumers — no imports).
  //   3. Sibling-file probe (same dir as origin) as a last resort.
  const importedFile = resolveImport(source.origin, node.tag, options.ts ?? null);
  if (importedFile) {
    const importedSource = findTemplateSource({ declFile: importedFile, ts: options.ts });
    if (importedSource) {
      return resolvePascalRecursionWith(node, source, importedSource, options, visited, depth);
    }
  }

  const byName = findTemplateSource({
    consumerFile: source.origin,
    componentName: node.tag,
    ts: options.ts,
  });
  if (byName) return resolvePascalRecursionWith(node, source, byName, options, visited, depth);

  const sibling = trySiblingProbe(source.origin, node.tag);
  if (sibling) return resolvePascalRecursionWith(node, source, sibling, options, visited, depth);

  return TRANSPARENT;
}

function resolvePascalRecursionWith(
  node: AST.ElementNode,
  outerSource: TemplateSource,
  wrapperSource: TemplateSource,
  options: ResolveOptions,
  visited: Set<string>,
  depth: number,
): Resolution {
  if (visited.has(wrapperSource.origin)) return TRANSPARENT;
  const newVisited = new Set(visited);
  newVisited.add(wrapperSource.origin);

  // Build the args we pass to the wrapper:
  // for each `@argName="literal"` on `<Outer>`, that's a literal pass.
  // for each `@argName={{@callerArg}}`, that's a passthrough — look up callerArg in our args.
  // for each `@argName={{this.prop}}`, evaluate prop against the outer
  // class's getter body — this is how HDS chains class-derived literals
  // through wrappers like `<HdsTextDisplay @tag={{this.tag}}>`.
  const passedArgs = new Map<string, string>();
  for (const attr of node.attributes) {
    if (!attr.name.startsWith('@')) continue;
    const argName = attr.name.slice(1);
    if (attr.value.type === 'TextNode') {
      passedArgs.set(argName, attr.value.chars);
    } else if (attr.value.type === 'MustacheStatement') {
      const expr = attr.value.path;
      if (expr.type === 'PathExpression') {
        if (expr.head?.type === 'AtHead') {
          const callerArgName = expr.head.name.replace(/^@/, '');
          const callerVal = options.consumerArgs?.get(callerArgName);
          if (callerVal !== undefined) passedArgs.set(argName, callerVal);
        } else if (expr.head?.type === 'ThisHead') {
          const propName = expr.tail[0];
          if (propName && options.ts) {
            const val = resolveThisProp(outerSource, propName, options);
            if (val !== null) passedArgs.set(argName, val);
          }
        }
      }
    }
  }

  return resolveTemplate(wrapperSource, {
    consumerArgs: passedArgs,
    ts: options.ts,
    visited: newVisited,
    depth: depth + 1,
  });
}

function trySiblingProbe(originFile: string, componentName: string): TemplateSource | null {
  const dir = path.dirname(originFile);
  const ext = path.extname(originFile);
  for (const e of [ext, '.gts', '.gjs', '.hbs']) {
    const file = path.join(dir, `${componentName}${e}`);
    if (fs.existsSync(file)) {
      return findTemplateSource({ declFile: file, ts: null });
    }
  }
  return null;
}

// --- yield-hash binding resolution ---------------------------------------
//
// Pattern: a parent component yields a hash of bound components,
// consumer destructures via block-params, dotted invocation refers
// to a hash entry.
//
//   {{!-- Parent (e.g. HdsStepperList.gts) --}}
//   <ol>{{yield (hash Step=WrappedStep)}}</ol>
//
//   {{!-- Consumer --}}
//   <HdsStepperList as |S|>
//     <S.Step>...</S.Step>
//   </HdsStepperList>
//
// `<S.Step>` resolves to whatever WrappedStep renders. This function
// takes the parent template + the hash key and returns the resolution.

export interface YieldHashBindingOptions {
  /** Parent's template source (e.g. HdsStepperList.gts). */
  parentSource: TemplateSource;
  /** The hash key from the dotted invocation: `<S.Step>` → 'Step'. */
  hashKey: string;
  /** Args the consumer passed to the parent (`<HdsStepperList @x="y">` →
   *  {x: 'y'}). Lets `(hash X=@arg)` chain through to the consumer. */
  parentArgs?: ReadonlyMap<string, string>;
  ts?: typeof TS | null;
  visited?: Set<string>;
  depth?: number;
}

export function resolveYieldHashBinding(opts: YieldHashBindingOptions): Resolution {
  const { parentSource, hashKey, parentArgs, ts, visited, depth } = opts;
  let ast: AST.Template;
  try {
    ast = parseTemplate(parentSource.content);
  } catch {
    return TRANSPARENT;
  }

  const entry = findYieldHashEntry(ast, hashKey);
  if (!entry) return TRANSPARENT;

  return resolveBinding(entry.value, parentSource, entry.ancestors, {
    consumerArgs: parentArgs,
    ts: ts ?? null,
    visited,
    depth,
  });
}

// Resolve a re-yielded block-param hash entry: `{{yield (hash
// Legend=F.Legend)}}` where `F` is the block param of the enclosing
// `<Binder as |F|>` (`binderNode`). The yielded sub-component is whatever
// `Binder` itself yields under `Legend`, so resolve `Binder`'s source and
// recurse into its yield-hash. Mirrors HDS's `HdsFormCheckboxGroup`
// re-yielding `HdsFormFieldset`'s `F.Legend` — without this `<G.Legend>`
// fell back to the binder's `<fieldset>` Element type and FP-fired
// `wcag/h71`. `binderNode` is the EXACT in-scope binder for the resolved
// entry (from its ancestor stack), so a re-yield value reused under
// several binders resolves against the right one.
function resolveBlockParamReyield(
  binderNode: AST.ElementNode,
  hashKey: string,
  parentSource: TemplateSource,
  options: ResolveOptions,
): Resolution {
  const depth = options.depth ?? 0;
  if (depth >= MAX_DEPTH) return TRANSPARENT;

  const binderArgs = collectBinderArgs(binderNode, parentSource, options);
  const binderSource = resolveBinderSource(binderNode.tag, parentSource, options.ts ?? null);
  if (!binderSource) return TRANSPARENT;

  return resolveYieldHashBinding({
    parentSource: binderSource,
    hashKey,
    parentArgs: binderArgs,
    ts: options.ts ?? null,
    visited: options.visited,
    depth: depth + 1,
  });
}

// The binder is invoked WITHIN this template (`<Binder @x="y" as |F|>`),
// so any `@arg`-driven yield-hash entry inside Binder must resolve against
// the args passed HERE — not the outer component's consumer args. Collect:
//   - literal `@arg="lit"`,
//   - `@arg={{@caller}}` passthrough (look up in this component's args),
//   - `@arg={{this.prop}}` class-derived literal (walk this component's
//     getter, mirroring `resolvePascalRecursionWith`).
function collectBinderArgs(
  binderNode: AST.ElementNode,
  parentSource: TemplateSource,
  options: ResolveOptions,
): Map<string, string> {
  const binderArgs = new Map<string, string>();
  for (const attr of binderNode.attributes) {
    if (!attr.name.startsWith('@')) continue;
    const argName = attr.name.slice(1);
    if (attr.value.type === 'TextNode') {
      binderArgs.set(argName, attr.value.chars);
    } else if (
      attr.value.type === 'MustacheStatement'
      && attr.value.path.type === 'PathExpression'
    ) {
      const expr = attr.value.path;
      if (expr.head?.type === 'AtHead') {
        const caller = expr.head.name.replace(/^@/, '');
        const v = options.consumerArgs?.get(caller);
        if (v !== undefined) binderArgs.set(argName, v);
      } else if (expr.head?.type === 'ThisHead') {
        const propName = expr.tail[0];
        if (propName && options.ts) {
          const v = resolveThisProp(parentSource, propName, options);
          if (v !== null) binderArgs.set(argName, v);
        }
      }
    }
  }
  return binderArgs;
}

// Like `resolveYieldHashBinding` but returns the underlying
// `TemplateSource` (plus any curried `@arg` additions from a
// `(component Inner …)` wrapper) instead of the leaf `Resolution`.
// Used by the consumer-side walker in `lib/glint.ts` to chain
// multi-level dotted bindings: `<FSH.Title>` whose binder is
// itself dotted (`<FS.Header as |FSH|>`, with FS coming from
// `<FORM.Section as |FS|>`, with FORM from `<HdsForm as |FORM|>`).
// Each hop yields the next level's parent template source, until
// we reach the leaf and let the normal resolver pick its tag.
export interface YieldHashSourceResult {
  source: TemplateSource;
  /** `@arg="literal"` pairs collected from any `(component Inner …)`
   *  curry on the hash entry. The caller should pass these into the
   *  next-level lookup so the inner's destructure defaults respect
   *  them (HDS `(component HdsFormHeaderTitle size="300")`). */
  curriedArgs: Map<string, string>;
}

export function resolveYieldHashBindingSource(
  opts: YieldHashBindingOptions,
): YieldHashSourceResult | null {
  const { parentSource, hashKey, ts, visited, depth } = opts;
  let ast: AST.Template;
  try {
    ast = parseTemplate(parentSource.content);
  } catch {
    return null;
  }

  const entry = findYieldHashEntry(ast, hashKey);
  if (!entry) return null;

  // Unwrap `(component Inner @arg="lit" …)` to extract the inner
  // identifier + curried args.
  let target: AST.Expression = entry.value;
  const curriedArgs = new Map<string, string>();
  if (
    target.type === 'SubExpression'
    && target.path.type === 'PathExpression'
    && target.path.original === 'component'
    && target.params[0]
  ) {
    for (const pair of target.hash.pairs) {
      if (pair.value.type === 'StringLiteral') {
        curriedArgs.set(pair.key, pair.value.value);
      }
    }
    target = target.params[0];
  }

  if (target.type !== 'PathExpression') return null;
  if (target.head?.type !== 'VarHead') return null;

  // Re-yield: `Header=F.Header` where `F` is the block param of an
  // enclosing `<Binder as |F|>`. Mirror `resolveBlockParamReyield` at the
  // source level — resolve the binder's source and follow ITS yield-hash
  // for the inner key — so deeper dotted chains off a re-yielded component
  // can be followed (the leaf resolver and the source chainer stay in
  // sync). Falls back to the bare-identifier path when `F` isn't a binder.
  if (target.tail.length > 0) {
    const d = depth ?? 0;
    const binderNode = d < MAX_DEPTH ? nearestBinderFor(entry.ancestors, target.head.name) : null;
    if (binderNode) {
      const binderSource = resolveBinderSource(binderNode.tag, parentSource, ts ?? null);
      if (!binderSource) return null;
      const nested = resolveYieldHashBindingSource({
        parentSource: binderSource,
        hashKey: target.tail[0]!,
        ts: ts ?? null,
        visited,
        depth: d + 1,
      });
      if (!nested) return null;
      return { source: nested.source, curriedArgs: new Map([...curriedArgs, ...nested.curriedArgs]) };
    }
    return null;
  }

  const name = target.head.name;

  // Reuse `resolveImport` + `findTemplateSource` directly so we get
  // the TemplateSource rather than walking the leaf's template again.
  const importedFile = resolveImport(parentSource.origin, name, ts ?? null);
  let source: TemplateSource | null = null;
  if (importedFile) {
    source = findTemplateSource({ declFile: importedFile, ts: ts ?? null });
  }
  if (!source) {
    source = findTemplateSource({
      declFile: parentSource.origin,
      componentName: name,
      ts: ts ?? null,
    });
  }
  if (!source) return null;
  // Track visited in case the caller chains multiple hops.
  void visited;
  return { source, curriedArgs };
}

interface YieldHashEntry {
  /** The `{{yield (hash <hashKey>=<value>)}}` entry's value expression. */
  value: AST.Expression;
  /** ElementNode ancestors of the matched entry, outermost first. Lets a
   *  re-yield value (`F.Legend`) resolve its in-scope binder (`<Binder as
   *  |F|>`) to the one actually wrapping THIS entry — not merely the first
   *  binder in the template that binds the same param name. */
  ancestors: AST.ElementNode[];
}

// Walk the parent template for the FIRST `{{yield (hash <hashKey>=<expr>)}}`
// and return its value + enclosing element ancestors, or null when absent.
function findYieldHashEntry(
  ast: AST.Template,
  hashKey: string,
): YieldHashEntry | null {
  let result: YieldHashEntry | null = null;
  const stack: AST.ElementNode[] = [];
  function visit(node: AST.Node): void {
    if (result) return;
    if (node.type === 'MustacheStatement' || node.type === 'SubExpression') {
      const mu = node as AST.MustacheStatement | AST.SubExpression;
      if (mu.path.type === 'PathExpression' && mu.path.original === 'yield') {
        for (const param of mu.params) {
          if (param.type !== 'SubExpression') continue;
          if (param.path.type !== 'PathExpression') continue;
          if (param.path.original !== 'hash') continue;
          for (const pair of param.hash.pairs) {
            if (pair.key === hashKey) {
              result = { value: pair.value, ancestors: [...stack] };
              return;
            }
          }
        }
      }
    }
    if (node.type === 'ElementNode') {
      stack.push(node);
      for (const child of node.children) visit(child);
      stack.pop();
    } else if (node.type === 'BlockStatement') {
      for (const child of node.program.body) visit(child);
      if (node.inverse) for (const child of node.inverse.body) visit(child);
    } else if (node.type === 'Template') {
      for (const child of node.body) visit(child);
    }
  }
  visit(ast);
  return result;
}

// Nearest enclosing binder (`<Tag as |…paramName…|>`) among an entry's
// element ancestors — the in-scope binder for a re-yielded `paramName.key`
// reference. Restricted to resolvable wrapper tags (`isResolvableWrapperTag`):
// dotted (`F.Foo`) / named-block (`:body`) binders can't be name-resolved.
function nearestBinderFor(
  ancestors: ReadonlyArray<AST.ElementNode>,
  paramName: string,
): AST.ElementNode | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const el = ancestors[i]!;
    if (isResolvableWrapperTag(el.tag) && el.blockParams.includes(paramName)) return el;
  }
  return null;
}

// Resolve the TemplateSource of a binder element (`<Binder …>`) invoked
// within `parentSource`'s template, mirroring resolvePascalRecursion's
// lookup order. Shared by both the leaf (resolveBlockParamReyield) and the
// source (resolveYieldHashBindingSource) re-yield paths so they stay in
// sync. The same-file lookup is gated against the degenerate self-match:
// single-template files (every `.hbs`, many `.gts/.gjs`) return their sole
// `<template>` regardless of the requested name, which would be the parent
// itself — accept it only when it picked a DIFFERENT block.
function resolveBinderSource(
  binderTag: string,
  parentSource: TemplateSource,
  ts: typeof TS | null,
): TemplateSource | null {
  const importedFile = resolveImport(parentSource.origin, binderTag, ts);
  let binderSource: TemplateSource | null = importedFile
    ? findTemplateSource({ declFile: importedFile, ts })
    : null;
  if (!binderSource) {
    const sameFile = findTemplateSource({ declFile: parentSource.origin, componentName: binderTag, ts });
    if (sameFile && !(sameFile.origin === parentSource.origin && sameFile.content === parentSource.content)) {
      binderSource = sameFile;
    }
  }
  if (!binderSource) {
    binderSource = findTemplateSource({ consumerFile: parentSource.origin, componentName: binderTag, ts });
  }
  if (!binderSource) {
    binderSource = trySiblingProbe(parentSource.origin, binderTag);
  }
  return binderSource;
}

// Resolve a binding expression (the value of a hash entry) to a
// Resolution. Three forms:
//   - PathExpression with VarHead (`WrappedStep`): in-scope identifier;
//     follow the parent's import.
//   - PathExpression with ThisHead (`this.WrappedStep`): class-property
//     assignment; walk the class body for `WrappedStep = X`.
//   - PathExpression with AtHead (`@arg`): pass-through; look up in
//     parentArgs.
function resolveBinding(
  expr: AST.Expression,
  parentSource: TemplateSource,
  ancestors: ReadonlyArray<AST.ElementNode>,
  options: ResolveOptions,
): Resolution {
  // `Title=(component HdsFormHeaderTitle size="300")` — the hash
  // entry is a curried `(component …)` call rather than a bare
  // identifier. Extract the wrapped component reference, merge the
  // curried `@arg="literal"` pairs into the parentArgs (so the
  // inner's destructure defaults respect them), and recurse.
  if (expr.type === 'SubExpression') {
    if (expr.path.type !== 'PathExpression') return TRANSPARENT;
    if (expr.path.original !== 'component') return TRANSPARENT;
    const componentRef = expr.params[0];
    if (!componentRef) return TRANSPARENT;
    // Collect `@arg="literal"` curried args from the `(component …)`
    // hash pairs. Only string-literal values are taken — dynamic
    // values can't be statically pinned and would just shadow a
    // potentially-correct caller value.
    const curriedArgs = new Map<string, string>(options.consumerArgs ?? new Map());
    for (const pair of expr.hash.pairs) {
      if (pair.value.type === 'StringLiteral') {
        curriedArgs.set(pair.key, pair.value.value);
      }
    }
    return resolveBinding(componentRef, parentSource, ancestors, {
      ...options,
      consumerArgs: curriedArgs,
    });
  }

  if (expr.type !== 'PathExpression') return TRANSPARENT;
  if (!expr.head) return TRANSPARENT;

  if (expr.head.type === 'VarHead') {
    // `F.Legend` — when `F` is the block param of an enclosing `<Binder as
    // |F|>`, the yielded sub-component is whatever Binder re-yields under
    // `Legend`. But `VarHead`+tail is also the general shape for property
    // access on any in-scope value; when `F` is not a binder block param
    // (no matching ancestor), fall back to resolving the head name
    // directly (the prior behavior). A bare `Foo` with no tail is a local
    // import / in-scope component.
    if (expr.tail.length > 0) {
      const binderNode = nearestBinderFor(ancestors, expr.head.name);
      if (binderNode) {
        return resolveBlockParamReyield(binderNode, expr.tail[0]!, parentSource, options);
      }
    }
    return resolveByName(expr.head.name, parentSource, options);
  }

  if (expr.head.type === 'AtHead') {
    const argName = expr.head.name.replace(/^@/, '');
    const value = options.consumerArgs?.get(argName);
    if (!value) return TRANSPARENT;
    if (isNativeTagName(value)) {
      return { kind: 'tag', tag: value, attrs: new Map(), hasSplat: true };
    }
    return TRANSPARENT;
  }

  if (expr.head.type === 'ThisHead') {
    const propName = expr.tail[0];
    if (!propName) return TRANSPARENT;
    const ts = options.ts;
    if (!ts) return TRANSPARENT;
    const targetName = readClassPropAssignment(parentSource.origin, propName, ts);
    if (!targetName) return TRANSPARENT;
    return resolveByName(targetName, parentSource, options);
  }

  return TRANSPARENT;
}

// Resolve a named identifier to a TemplateSource. Tries:
//   1. An import in the parent's origin (`import Foo from '...'`).
//   2. A same-file declaration (the parent's origin contains
//      `const Foo = <template>...</template>;`). Multi-template files
//      get matched by name.
function resolveByName(
  name: string,
  parentSource: TemplateSource,
  options: ResolveOptions,
): Resolution {
  const importedFile = resolveImport(parentSource.origin, name, options.ts ?? null);
  if (importedFile) {
    const source = findTemplateSource({ declFile: importedFile, ts: options.ts });
    if (source) return resolveTemplate(source, options);
  }
  const sameFileSource = findTemplateSource({
    declFile: parentSource.origin,
    componentName: name,
    ts: options.ts,
  });
  if (sameFileSource) return resolveTemplate(sameFileSource, options);
  return TRANSPARENT;
}

// Walk the class body in `originFile` for a property assignment
// `<propName> = <Identifier>;`. Returns the right-hand identifier name
// (the imported symbol), or null when the assignment doesn't fit this
// shape (literal value, computed expression, etc.).
function readClassPropAssignment(
  originFile: string,
  propName: string,
  ts: typeof TS,
): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(originFile, 'utf8');
  } catch {
    return null;
  }
  if (originFile.endsWith('.gts') || originFile.endsWith('.gjs')) {
    contents = stripTemplateBlocks(contents, originFile);
  }
  const sf = ts.createSourceFile(
    originFile,
    contents,
    ts.ScriptTarget.Latest,
    false,
    originFile.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  let result: string | null = null;
  function visit(node: TS.Node): void {
    if (result) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        if (
          ts.isPropertyDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === propName &&
          member.initializer &&
          ts.isIdentifier(member.initializer)
        ) {
          result = member.initializer.text;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}

// --- conditionals --------------------------------------------------------
//
// {{#if x}}...{{else}}...{{/if}} or {{#unless x}}...{{/unless}}: resolve
// each branch. If both branches resolve to the same tag, return that;
// otherwise transparent (an FP-safe answer that html-validate handles).

function isConditional(stmt: AST.BlockStatement): boolean {
  if (stmt.path.type !== 'PathExpression') return false;
  return stmt.path.original === 'if' || stmt.path.original === 'unless';
}

// Statically evaluate a condition expression against the consumer's
// @args (plus class-property indirection through `this.<prop>`).
// Returns `true`/`false` when the condition is determinable, `null`
// when not.
//
// Supported forms:
//   - PathExpression with AtHead (`@arg`): truthy if consumerArgs has
//     a non-empty value for it. Strings are truthy unless empty/'false'.
//   - PathExpression with ThisHead (`this.<prop>`): walk the class
//     getter for the prop and recurse; HDS pattern where a
//     `componentTag` getter destructures `{ tag = 'div' } = this.args`
//     and returns `tag`.
//   - SubExpression `(eq <a> <b>)`: literal equality between operands
//     where each operand is either a literal, an @arg, or a `this.X`
//     prop that traces back to an @arg.
//   - `(not <inner>)`: inverts a determinable inner condition.
function evaluateConditionAgainstArgs(
  expr: AST.Expression,
  source: TemplateSource,
  options: ResolveOptions,
): boolean | null {
  const value = readLiteralValue(expr, source, options);
  if (value !== null) {
    return value !== '' && value !== 'false';
  }
  if (expr.type === 'BooleanLiteral') return expr.value;
  if (expr.type === 'NullLiteral' || expr.type === 'UndefinedLiteral') return false;
  if (expr.type === 'SubExpression' && expr.path.type === 'PathExpression') {
    const helper = expr.path.original;
    if (helper === 'eq' && expr.params.length === 2) {
      const a = readLiteralValue(expr.params[0]!, source, options);
      const b = readLiteralValue(expr.params[1]!, source, options);
      if (a === null || b === null) return null;
      return a === b;
    }
    if (helper === 'not' && expr.params.length === 1) {
      const inner = evaluateConditionAgainstArgs(expr.params[0]!, source, options);
      return inner === null ? null : !inner;
    }
  }
  return null;
}

// Resolve an expression to a string literal value (for `eq`-style
// helper evaluation). Returns null when the expression isn't a known
// literal or arg/prop-resolvable PathExpression.
function readLiteralValue(
  expr: AST.Expression,
  source: TemplateSource,
  options: ResolveOptions,
): string | null {
  if (expr.type === 'StringLiteral') return expr.value;
  if (expr.type === 'NumberLiteral') return String(expr.value);
  if (expr.type === 'BooleanLiteral') return String(expr.value);
  if (expr.type === 'PathExpression') {
    if (expr.head?.type === 'AtHead') {
      const argName = expr.head.name.replace(/^@/, '');
      return options.consumerArgs?.get(argName) ?? null;
    }
    if (expr.head?.type === 'ThisHead') {
      const propName = expr.tail[0];
      if (!propName || !options.ts) return null;
      // Reuses the same getter-walk used by the (element this.prop)
      // polymorphic-tag chain trace (HDS pattern where a class getter
      // destructures `{ tag = 'div' } = this.args` and returns `tag`).
      return resolveThisProp(source, propName, options);
    }
  }
  return null;
}

function resolveConditional(
  stmt: AST.BlockStatement,
  source: TemplateSource,
  options: ResolveOptions,
): Resolution {
  // Static evaluation of the condition expression against the consumer's
  // @args. For `{{#if (eq @tag "li")}}<li>{{else}}<div>{{/if}}` with
  // consumer @tag="li", the IF is statically true → pick `program`
  // branch. For `{{#unless ...}}`, invert.
  //
  // Without this, branches that would have converged to a single tag
  // at runtime appear as differing-tag union to the resolver →
  // bails to transparent → cascades FPs at the consumer.
  const isUnless = stmt.path.type === 'PathExpression' && stmt.path.original === 'unless';
  const condValue = stmt.params[0]
    ? evaluateConditionAgainstArgs(stmt.params[0], source, options)
    : null;
  if (condValue !== null) {
    const truthy = isUnless ? !condValue : condValue;
    const arm = truthy ? stmt.program : stmt.inverse;
    if (arm) return resolveBody(arm.body, source, options);
    // Empty arm — the conditional resolves to whitespace, not an
    // element. Treat as transparent: caller's body had no element-
    // producing content in the picked branch.
    return TRANSPARENT;
  }

  const branches = [resolveBody(stmt.program.body, source, options)];
  if (stmt.inverse) branches.push(resolveBody(stmt.inverse.body, source, options));

  // Converge: all branches must agree on tag (and yieldAncestor).
  let pinned: TagResolution | null = null;
  for (const b of branches) {
    if (b.kind === 'transparent') return TRANSPARENT;
    if (!pinned) {
      pinned = b;
      continue;
    }
    if (b.tag !== pinned.tag) return TRANSPARENT;
    if (b.yieldAncestorTag !== pinned.yieldAncestorTag) return TRANSPARENT;
  }
  return pinned ?? TRANSPARENT;
}

// --- passthrough blocks --------------------------------------------------
//
// {{#each ...}}...{{/each}} / {{#with}} / etc. — body produces the element.
// Whitelist for safety; bare `(some-helper)` blocks could do anything.

function isPassthroughBlock(stmt: AST.BlockStatement): boolean {
  if (stmt.path.type !== 'PathExpression') return false;
  const name = stmt.path.original;
  return name === 'each' || name === 'with';
}

// --- native-tag check ---------------------------------------------------

import htmlTags from 'html-tags';
import svgTags from 'svg-tags';
import { mathmlTagNames } from 'mathml-tag-names';

const NATIVE_TAGS = new Set<string>([...htmlTags, ...svgTags, ...mathmlTagNames]);

function isNativeTagName(tag: string): boolean {
  return NATIVE_TAGS.has(tag);
}

// A tag we attempt to resolve as a component wrapper: PascalCase, not
// dotted (`F.Item` is a yield-binding/curried path), not a named-block
// slot (`:body`). Deliberately broader than `/^[A-Z][A-Za-z0-9]*$/` so it
// also covers namespaced (`Foo::Bar`) and underscore identifiers — the
// same set the wrapper-recursion and block-param-binder lookups treat as
// resolvable, kept in one place so the two can't drift apart.
function isResolvableWrapperTag(tag: string): boolean {
  return /^[A-Z]/.test(tag) && !tag.includes('.') && !tag.startsWith(':');
}
