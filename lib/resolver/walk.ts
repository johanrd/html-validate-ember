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

const TRANSPARENT: TransparentResolution = { kind: 'transparent' };
const MAX_DEPTH = 10;

// --- entry point ---------------------------------------------------------

export function resolveTemplate(source: TemplateSource, options: ResolveOptions = {}): Resolution {
  let ast: AST.Template;
  try {
    ast = preprocess(source.content);
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
  if (/^[A-Z]/.test(node.tag) && !node.tag.includes('.') && !node.tag.startsWith(':')) {
    return resolvePascalRecursion(node, source, options);
  }

  // Dotted (`<This.Foo>`, `<F.Item>`) — yield-binding or curried path.
  // We don't statically resolve these; transparent is the safe answer.
  return TRANSPARENT;
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
  const hasSplat = innerTag ? innerTag.attributes.some((a) => a.name === '...attributes') : true;
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
function resolveThisProp(
  source: TemplateSource,
  propName: string,
  options: ResolveOptions,
): string | null {
  const ts = options.ts;
  if (!ts) return null;
  const classBody = readClassBody(source.origin, ts);
  if (!classBody) return null;

  for (const member of classBody) {
    if (!ts.isGetAccessor(member)) continue;
    if (!ts.isIdentifier(member.name) || member.name.text !== propName) continue;
    return analyzeGetterBody(ts, member.body, options.consumerArgs ?? new Map());
  }
  return null;
}

function readClassBody(origin: string, ts: typeof TS): TS.NodeArray<TS.ClassElement> | null {
  let contents: string;
  try {
    contents = fs.readFileSync(origin, 'utf8');
  } catch {
    return null;
  }
  const sf = ts.createSourceFile(
    origin,
    contents,
    ts.ScriptTarget.Latest,
    false,
    origin.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  let found: TS.NodeArray<TS.ClassElement> | null = null;
  function visit(node: TS.Node): void {
    if (found) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      found = node.members;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

function analyzeGetterBody(
  ts: typeof TS,
  body: TS.Block | undefined,
  consumerArgs: ReadonlyMap<string, string>,
): string | null {
  if (!body) return null;
  // Walk for VariableStatement that destructures from `this.args`,
  // followed by `return <varName>`.
  const destructureDefaults = new Map<string, string>();
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
          if (elem.initializer && ts.isStringLiteral(elem.initializer)) {
            defaultVal = elem.initializer.text;
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
      return resolvePascalRecursionWith(node, importedSource, options, visited, depth);
    }
  }

  const byName = findTemplateSource({
    consumerFile: source.origin,
    componentName: node.tag,
    ts: options.ts,
  });
  if (byName) return resolvePascalRecursionWith(node, byName, options, visited, depth);

  const sibling = trySiblingProbe(source.origin, node.tag);
  if (sibling) return resolvePascalRecursionWith(node, sibling, options, visited, depth);

  return TRANSPARENT;
}

function resolvePascalRecursionWith(
  node: AST.ElementNode,
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
  const passedArgs = new Map<string, string>();
  for (const attr of node.attributes) {
    if (!attr.name.startsWith('@')) continue;
    const argName = attr.name.slice(1);
    if (attr.value.type === 'TextNode') {
      passedArgs.set(argName, attr.value.chars);
    } else if (attr.value.type === 'MustacheStatement') {
      const expr = attr.value.path;
      if (expr.type === 'PathExpression' && expr.head?.type === 'AtHead') {
        const callerArgName = expr.head.name.replace(/^@/, '');
        const callerVal = options.consumerArgs?.get(callerArgName);
        if (callerVal !== undefined) passedArgs.set(argName, callerVal);
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
    ast = preprocess(parentSource.content);
  } catch {
    return TRANSPARENT;
  }

  const binding = findYieldHashEntry(ast, hashKey);
  if (!binding) return TRANSPARENT;

  return resolveBinding(binding, parentSource, {
    consumerArgs: parentArgs,
    ts: ts ?? null,
    visited,
    depth,
  });
}

// Walk the parent template for `{{yield (hash <hashKey>=<expr>)}}` and
// return <expr>, or null when not found.
function findYieldHashEntry(
  ast: AST.Template,
  hashKey: string,
): AST.Expression | null {
  let result: AST.Expression | null = null;
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
              result = pair.value;
              return;
            }
          }
        }
      }
    }
    if (node.type === 'ElementNode') {
      for (const child of node.children) visit(child);
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
  options: ResolveOptions,
): Resolution {
  if (expr.type !== 'PathExpression') return TRANSPARENT;
  if (!expr.head) return TRANSPARENT;

  if (expr.head.type === 'VarHead') {
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

function resolveConditional(
  stmt: AST.BlockStatement,
  source: TemplateSource,
  options: ResolveOptions,
): Resolution {
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
