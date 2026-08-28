// Optional Glint integration. When a type backend is available for the
// host project (see `lib/backend/`), we use it to extract TypeScript type
// information for attribute-value mustache positions. The transformer's
// static-text resolver then sees `popover={{@mode}}` (where `@mode: 'auto'
// | 'manual' | 'hint'` from the component's Signature) as a
// string-literal-union and embeds one of the values, letting
// html-validate's enum rules apply.
//
// Without a backend: all functions return null and the transformer falls
// back to its non-Glint static-resolution path.

import type * as TS from 'typescript';

import { Preprocessor } from 'content-tag';
import { preprocess as glimmerPreprocess, type AST } from '@glimmer/syntax';

import { isComponentTag, isNativeTag } from '../blank.js';
import type { ComponentAttrs } from './builtin-components.js';
import { readCache, writeCache } from './cache.js';
import type { AttrTypeInfo, ExtractionResult } from './cache.js';
import { findTemplateSource } from './resolver/template-source.js';
import {
  chooseSubstitution,
  resolveTemplate,
  resolveThisProp,
  resolveYieldHashBinding,
  resolveYieldHashBindingSource,
  type Resolution,
} from './resolver/walk.js';
import type { TemplateSource } from './resolver/template-source.js';
import { backendFor } from './backend/index.js';
import type {
  CheckerLike,
  PreloadProgress,
  PreloadStats,
  ProgramLike,
  SymbolLike,
  TsSyntax,
  TypeLike,
  VirtualRange,
} from './backend/index.js';

export type { PreloadStats } from './backend/index.js';

const consumerPreprocessor = new Preprocessor();

/**
 * Pre-load a batch of `.gts` / `.gjs` files into the type backend so the
 * subsequent per-file `extractAttrTypeMap` calls reuse one program build
 * (TypeScript 6) or one project snapshot (TypeScript 7) instead of
 * triggering N incremental rebuilds.
 *
 * Best-effort: failure to load a backend / find tsconfig / rewrite a
 * single file is silently skipped (caller's per-file path will run as
 * normal). Cached entries (per-file disk cache) are skipped — no need
 * to load them into the program if we'll just return cached results.
 */
export function preloadGlintFiles(
  filenames: readonly string[],
  onProgress?: (p: PreloadProgress) => void,
): PreloadStats {
  const empty = (): PreloadStats => ({
    loaded: 0,
    cached: 0,
    skipped: 0,
    skips: { nonGts: [], readError: [], rewriteError: [], rewriteEmpty: [] },
  });
  if (!filenames || filenames.length === 0) {
    return empty();
  }
  const allSkipped = (): PreloadStats => {
    const s = empty();
    s.skipped = filenames.length;
    return s;
  };
  // Find the first .gts/.gjs file to seed backend + tsconfig discovery.
  const seed = filenames.find((f) => f.endsWith('.gts') || f.endsWith('.gjs'));
  if (!seed) return allSkipped();
  const backend = backendFor(seed);
  if (!backend) return allSkipped();
  return backend.preload(filenames, onProgress);
}

// TypeScript ships `HTMLElementTagNameMap` in lib.dom.d.ts as
// `{ a: HTMLAnchorElement; button: HTMLButtonElement; ... }`. We invert it
// at runtime using the project's TS program — no hardcoded list to keep in
// sync with TS lib version. SVG and MathML maps follow the same shape.
//
// Tags whose mapped type is the bare base class (`HTMLElement`,
// `SVGElement`, `MathMLElement`) are *intentionally excluded* from the
// inversion. Many tags share the bare base — `abbr`, `address`, `b`, `cite`,
// `code`, …  all map to `HTMLElement` — so the inversion would arbitrarily
// pick whichever appears first (currently `abbr`) and FP-attribute
// downstream content. A component declaring `Signature['Element'] =
// HTMLElement` (the generic) typically means "I render *some* generic
// container; element-specific rules should not apply." Falling through to
// 'transparent' (children float to actual parent) is the right behaviour.
const GENERIC_BASE_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  'HTMLElement',
  'SVGElement',
  'MathMLElement',
]);

// Translate a Resolution from the canonical resolver into the
// componentTagMap + componentAttrMap shape that blank.ts consumes.
//
// `transparent` from the canonical resolver overrides any prior
// TS-side resolveComponentElement pick. The TS-side resolves to the
// FIRST matching branch of a Signature['Element'] union — which for
// `HTMLAnchorElement | HTMLButtonElement` arbitrarily picks one. The
// canonical resolver, however, walks the actual template AST: when
// the outer is a conditional with differing branches (HDS's
// `HdsInteractive` shape: `{{#if @route}}<LinkTo>{{else if @href}}
// <a>{{else}}<button>{{/if}}`), it returns transparent — meaning
// "no single tag pins this; children float to the actual parent."
// Overriding the arbitrary union pick with transparent eliminates
// FPs cascading from the wrong branch (`<div>` under `<button>` for
// elements that would actually render `<a>` at runtime).
function applyResolution(
  componentTagMap: Map<string, string>,
  componentAttrMap: Map<string, ComponentAttrs>,
  key: string,
  resolution: Resolution,
): void {
  if (resolution.kind === 'transparent') {
    componentTagMap.set(key, 'transparent');
    componentAttrMap.delete(key);
    return;
  }
  if (!isNativeTag(resolution.tag)) return;

  // Yield-ancestor preference + guards live in the shared
  // `chooseSubstitution` so the canonical-resolver path
  // (`buildResolutionMaps`) applies the exact same rule (issue #33).
  const { tag: chosenTag, attrs: chosenAttrs, hasSplat, fromYieldAncestor } =
    chooseSubstitution(resolution);

  componentTagMap.set(key, chosenTag);
  componentAttrMap.set(key, {
    tag: chosenTag,
    attrs: Object.fromEntries(chosenAttrs),
    hasSplat,
    fromYieldAncestor,
  });
}

// Parse the consumer file's <template> blocks and build:
//   1. argsByLoc: line:col → @arg literal values for each PascalCase
//      invocation. Lets the resolver propagate `@tag="li"` etc.
//   2. dottedBindings: line:col → resolution context for each dotted
//      invocation `<X.Y>`. Records the enclosing block's binder tag
//      and the hash key, so the resolver can follow the parent's
//      `{{yield (hash Y=...)}}` chain.

interface DottedBinding {
  /** Enclosing block's binder tag (e.g. 'HdsStepperList' for `<HdsStepperList as |S|>`). */
  binderTag: string;
  /** The hash key from the dotted invocation: `<S.Step>` → 'Step'. */
  hashKey: string;
  /** Args the consumer passed to the binder. Lets `(hash Y=@arg)` chain through. */
  binderArgs: Map<string, string>;
  /** line:col of the binder invocation (lookup key into a binder→decl map
   *  populated during the Glint walk). Lets us reach binder templates
   *  that live in the same consumer file (no import to follow). */
  binderKey: string;
}

interface ConsumerInfo {
  argsByLoc: Map<string, Map<string, string>>;
  dottedBindings: Map<string, DottedBinding>;
  // line:col → `this.<propName>` reference for PascalCase elements
  // whose tag is bound by `{{#let (element this.X) as |T|}}` in the
  // consumer's OWN template. Used to override Glint's TS-side union
  // pick (typically <h1> from HTMLHeadingElement) with the class
  // getter's actual default (typically 'div').
  ownLetElementByLoc: Map<string, string>;
}

function buildConsumerInfo(filename: string, contents: string): ConsumerInfo {
  const argsByLoc = new Map<string, Map<string, string>>();
  const dottedBindings = new Map<string, DottedBinding>();
  const ownLetElementByLoc = new Map<string, string>();
  let blocks: Array<{ contents: string; tagName: string }>;
  try {
    blocks = consumerPreprocessor.parse(contents, { filename });
  } catch {
    return { argsByLoc, dottedBindings, ownLetElementByLoc };
  }
  const templates = blocks.filter((b) => b.tagName === 'template');

  // A block-param scope binds names introduced via `<Binder as |x y|>`.
  // Inner scopes shadow outer; we walk a stack while traversing so a
  // nested `<A as |x|><B as |x|>` resolves `x` to the inner B-binding.
  interface Scope {
    paramName: string;
    binderTag: string;
    binderArgs: Map<string, string>;
    binderKey: string;
  }

  // Scope for `{{#let (element this.X) as |T|}}` bindings — the
  // PascalCase `T` shadows any imported component of the same name
  // inside the block body. Tracked as a stack alongside dotted-binding
  // scopes so nested `{{#let}}` blocks resolve `T` to the innermost
  // binding.
  interface LetElementScope {
    paramName: string;
    propName: string;
  }

  for (const block of templates) {
    let ast: AST.Template;
    try {
      ast = glimmerPreprocess(block.contents, { mode: 'codemod' });
    } catch {
      continue;
    }
    const scopeStack: Scope[] = [];
    const letElementStack: LetElementScope[] = [];
    function walk(node: AST.Node): void {
      if (node.type === 'ElementNode') {
        const elem = node;
        // Args + dotted-binding lookup happen on entry, before pushing
        // any scope this element introduces. Block-params shadow inside
        // its body, not at the binder itself.
        if (elem.loc.start && isComponentTag(elem.tag)) {
          const args = collectLiteralArgs(elem);
          const key = `${elem.loc.start.line}:${elem.loc.start.column}`;
          if (elem.tag.includes('.')) {
            const [paramName, ...tail] = elem.tag.split('.');
            const binding = lookupParam(scopeStack, paramName!);
            if (binding && tail.length === 1) {
              if (args.size > 0) argsByLoc.set(key, args);
              dottedBindings.set(key, {
                binderTag: binding.binderTag,
                hashKey: tail[0]!,
                binderArgs: binding.binderArgs,
                binderKey: binding.binderKey,
              });
            }
          } else {
            if (args.size > 0) argsByLoc.set(key, args);
            // Non-dotted candidate — check if it matches a let-element
            // binding in scope. If so, the actual tag is the class
            // getter's value, not whatever Glint's TS-side picks from
            // the (element ...) helper's union return type.
            const letBinding = lookupLetElement(letElementStack, elem.tag);
            if (letBinding) {
              ownLetElementByLoc.set(key, letBinding.propName);
            }
          }
        }
        // Push any block-params this element introduces.
        const pushedCount = elem.blockParams.length;
        const elemArgs = collectLiteralArgs(elem);
        const binderKey = elem.loc.start
          ? `${elem.loc.start.line}:${elem.loc.start.column}`
          : '';
        for (const paramName of elem.blockParams) {
          scopeStack.push({
            paramName,
            binderTag: elem.tag,
            binderArgs: elemArgs,
            binderKey,
          });
        }
        for (const child of elem.children) walk(child);
        for (let i = 0; i < pushedCount; i++) scopeStack.pop();
        return;
      }
      if (node.type === 'BlockStatement') {
        const letElementBinding = matchLetElementHelper(node);
        if (letElementBinding) letElementStack.push(letElementBinding);
        for (const child of node.program.body) walk(child);
        if (letElementBinding) letElementStack.pop();
        if (node.inverse) for (const child of node.inverse.body) walk(child);
        return;
      }
      if (node.type === 'Template') {
        for (const child of node.body) walk(child);
      }
    }
    walk(ast);
  }
  return { argsByLoc, dottedBindings, ownLetElementByLoc };
}

// Match `{{#let (element this.<propName>) as |<paramName>|}}` and
// return its (paramName, propName) binding. Returns null for any
// other block shape (regular `{{#let}}` with a non-helper expression,
// `(element @arg)` — at the OWN-template level @arg can't be
// resolved without a calling consumer; let canonical paths handle
// those via consumerArgs propagation).
function matchLetElementHelper(node: AST.BlockStatement): { paramName: string; propName: string } | null {
  if (node.path.type !== 'PathExpression') return null;
  if (node.path.original !== 'let') return null;
  const first = node.params[0];
  if (!first || first.type !== 'SubExpression') return null;
  if (first.path.type !== 'PathExpression') return null;
  if (first.path.original !== 'element') return null;
  const inner = first.params[0];
  if (!inner || inner.type !== 'PathExpression') return null;
  if (inner.head?.type !== 'ThisHead') return null;
  const propName = inner.tail[0];
  if (!propName) return null;
  const paramName = node.program.blockParams[0];
  if (!paramName) return null;
  return { paramName, propName };
}

function lookupLetElement(
  stack: ReadonlyArray<{ paramName: string; propName: string }>,
  name: string,
): { paramName: string; propName: string } | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.paramName === name) return stack[i]!;
  }
  return null;
}

function collectLiteralArgs(node: AST.ElementNode): Map<string, string> {
  const args = new Map<string, string>();
  for (const attr of node.attributes) {
    if (!attr.name.startsWith('@')) continue;
    const argName = attr.name.slice(1);
    if (attr.value.type === 'TextNode') {
      args.set(argName, attr.value.chars);
    }
  }
  return args;
}

function lookupParam(
  stack: ReadonlyArray<{
    paramName: string;
    binderTag: string;
    binderArgs: Map<string, string>;
    binderKey: string;
  }>,
  name: string,
): { binderTag: string; binderArgs: Map<string, string>; binderKey: string } | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.paramName === name) {
      return {
        binderTag: stack[i]!.binderTag,
        binderArgs: stack[i]!.binderArgs,
        binderKey: stack[i]!.binderKey,
      };
    }
  }
  return null;
}


function buildElementTypeToTag(ts: TsSyntax, program: ProgramLike): Map<string, string> {
  const map = new Map<string, string>();
  const tagNameMaps = ['HTMLElementTagNameMap', 'SVGElementTagNameMap', 'MathMLElementTagNameMap'];
  for (const fileName of program.getSourceFileNames()) {
    if (!/lib\.dom(?:\.iterable)?\.d\.ts$/.test(fileName)) {
      continue;
    }
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;
    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isInterfaceDeclaration(node) && tagNameMaps.includes(node.name.text)) {
        for (const member of node.members) {
          if (!ts.isPropertySignature(member) || !member.type) continue;
          const tag = ts.isStringLiteral(member.name)
            ? member.name.text
            : ts.isIdentifier(member.name)
            ? member.name.text
            : null;
          const typeName =
            ts.isTypeReferenceNode(member.type) && ts.isIdentifier(member.type.typeName)
              ? member.type.typeName.text
              : null;
          if (tag && typeName && !GENERIC_BASE_ELEMENT_TYPES.has(typeName) && !map.has(typeName)) {
            map.set(typeName, tag);
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  return map;
}

// Resolve a component invocation's rendered element type. Reads
// `emitComponent(...).element` — Glint's DSL surfaces the Signature's
// Element type there for both class-component and template-only-component
// (TOC) invocations. Returns:
//   - tag name (e.g. 'button')   if Element is a known DOM type
//   - 'transparent'              if Element is `unknown` (yields-only / no
//                                Element declared) — children float into
//                                parent, no wrapper element forced
//   - null                       if we can't introspect or Element is some
//                                other type — caller falls back to
//                                transparent neutralization
function resolveComponentElement(
  ts: TsSyntax,
  checker: CheckerLike,
  emitComponentCall: TS.CallExpression,
  elementTypeToTag: Map<string, string>,
): string | null {
  const callType = checker.getTypeAtLocation(emitComponentCall);
  const elementProp = callType.getProperty('element');
  if (!elementProp) {
    return null;
  }
  const elementType = checker.getTypeOfSymbolAtLocation(elementProp, emitComponentCall);
  // `Element: null` — the component declares it renders no element of its
  // own (a signature-less template-only component, or an explicit `null`).
  if (elementType.flags & ts.TypeFlags.Null) {
    return 'transparent';
  }
  // `unknown` and `any` are both ambiguous in this position. Glint can surface
  // `.element` this way for yielded-curried refs (`<C.Options>`), TOC
  // declarations (`: TOC<…> =` / `satisfies TOC<…>`), and also in files with
  // cascading TS errors.
  if (elementType.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) {
    const fromTOC = resolveElementFromTOCDeclaration(
      ts,
      checker,
      emitComponentCall,
      elementTypeToTag,
    );
    if (fromTOC !== null) return fromTOC;
    const fromRefType = resolveElementFromComponentRefType(
      ts,
      checker,
      emitComponentCall,
      elementTypeToTag,
    );
    if (fromRefType !== null) return fromRefType;
    return 'transparent';
  }
  // Pick a single tag for unions: take the first matching branch
  // (branches with no DOM mapping are skipped, see matchElementTypeToTag).
  return matchElementTypeToTag(ts, elementType, elementTypeToTag);
}

function matchElementTypeToTag(
  ts: TsSyntax,
  elementType: TypeLike,
  elementTypeToTag: Map<string, string>,
): string | null {
  // Generic base classes (`HTMLElement`, `SVGElement`, `MathMLElement`) are
  // resolved as transparent rather than falling through to `null`. A null
  // return signals "no Glint resolution at all" and lets blank.ts apply
  // built-in name-based fallbacks (e.g. `<Input>` → `<input>`); for a
  // user component declaring `Signature['Element'] = HTMLElement` Glint
  // DID succeed and we just don't know which specific tag — transparent
  // (children float to parent) is the right semantic.
  const branches = ts.unionMembers(elementType) ?? [elementType];
  let allGenericBase = true;
  for (const branch of branches) {
    const name = branch.getSymbol()?.name;
    if (!name || !GENERIC_BASE_ELEMENT_TYPES.has(name)) {
      allGenericBase = false;
      break;
    }
  }
  if (allGenericBase) return 'transparent';
  // "Essentially all elements" — when the union covers (almost) every
  // HTMLElement type, the author has expressed "this component can
  // render any element"; picking the first matching branch arbitrarily
  // would substitute to whatever happened to be first (often `<a>` or
  // `<h1>`) and cascade FPs into the consumer's content-model checks.
  // Resolve to 'transparent' so children float to the actual parent.
  // Surfaced by HDS's `<HdsLayoutGrid>` declaring
  // `Element: HTMLElementTagNameMap[keyof HTMLElementTagNameMap]`.
  if (branches.length >= ESSENTIALLY_ALL_ELEMENTS_THRESHOLD) {
    return 'transparent';
  }
  // Pick a single tag for unions: take the first matching branch.
  for (const branch of branches) {
    const name = branch.getSymbol()?.name;
    if (name && elementTypeToTag.has(name)) {
      return elementTypeToTag.get(name) ?? null;
    }
  }
  return null;
}

// Threshold below which a union of HTML element types is treated as
// "the author chose specific tags" (we resolve to one of them) and
// above which it's treated as "the author chose effectively all tags"
// (we resolve to 'transparent'). HTMLElementTagNameMap has ~110
// entries; user-declared unions of "any of a handful" are typically
// 5-10 elements. Pick a threshold well above realistic per-component
// declarations but well below 110.
const ESSENTIALLY_ALL_ELEMENTS_THRESHOLD = 30;

// Recover the rendered tag from the *type* of the component-reference
// expression itself — for cases where Glint's `emitComponent(...).element`
// surfaces as `unknown`/`any` (for example yielded-curried block params like
// `<C.Options>`). In these cases the component-ref expression type can still
// carry Signature `Element` via a generic like `TOC<Sig>`.
//
// For both: `aliasTypeArguments[0]` is `Sig` — an object type with
// `Element: T` as a property — so we read `T` and map to a tag.
//
// Returns:
//   - tag name      if Element resolves to a known DOM type
//   - 'transparent' if Element is `unknown` (yields-only)
//   - null          if no aliasTypeArguments / no `Element` property —
//                   caller falls through to plain transparent.
function resolveElementFromComponentRefType(
  ts: TsSyntax,
  checker: CheckerLike,
  emitComponentCall: TS.CallExpression,
  elementTypeToTag: Map<string, string>,
): string | null {
  // emitCall is `emitComponent(resolve(Comp)({...}))`; navigate to the
  // component reference expression. Same path findComponentDeclSourceFile
  // uses to walk back to the component identifier.
  const innerCall = emitComponentCall.arguments[0];
  if (!innerCall || !ts.isCallExpression(innerCall)) return null;
  const resolveCall = innerCall.expression;
  if (!ts.isCallExpression(resolveCall)) return null;
  const componentRef = resolveCall.arguments[0];
  if (!componentRef) return null;
  const refType = checker.getTypeAtLocation(componentRef);
  // Try both shapes:
  //   - Type alias `type TOC<S> = …` — type-args land on
  //     `aliasTypeArguments`.
  //   - Generic interface `interface TOC<S>` — type-args land on the
  //     TypeReference's typeArguments, accessible via the public
  //     `checker.getTypeArguments`.
  // We don't know which form the host project's `TOC` (or other
  // signature-carrying generic) uses; check both.
  let sigType: TypeLike | undefined = ts.aliasTypeArguments(refType)?.[0];
  if (!sigType && (refType.objectFlags ?? 0) & ts.ObjectFlags.Reference) {
    sigType = checker.getTypeArguments(refType)[0];
  }
  if (!sigType) return null;
  const eltSym = sigType.getProperty('Element');
  if (!eltSym) return null;
  const eltType = checker.getTypeOfSymbolAtLocation(eltSym, componentRef);
  if (eltType.flags & ts.TypeFlags.Unknown) return 'transparent';
  const tag = matchElementTypeToTag(ts, eltType, elementTypeToTag);
  if (tag !== null) return tag;
  return null;
}

// Recover the rendered tag for a TOC declared with a TOC type annotation,
// in either of the two equivalent forms:
//   `const X = <template>...</template> satisfies TOC<{ Element: T }>;`
//   `const X: TOC<{ Element: T }> = <template>...</template>;`
//
// Glint's TOC overload reaches the same `.element` property surface as the
// class form, but for both the `satisfies` and `: TOC<…> =` forms `.element`
// surfaces as `unknown` (or `any` in cascading-error files) even though
// `T` is statically known. Walk the component reference back to its
// declaration, find the TOC<…> annotation, and pull `Element` off the
// type-arg directly.
//
// We gate on the type name being literally `TOC` to avoid mis-resolving
// unrelated generic annotations that happen to have a property called
// `Element` — a rare shape, but harmless to guard against.
//
// Returns:
//   - tag name      if Element resolves to a known DOM type
//   - 'transparent' if Element is `unknown` (yields-only TOC)
//   - null          if no TOC annotation found, no `Element` property,
//                   or some unexpected shape — caller falls through
function resolveElementFromTOCDeclaration(
  ts: TsSyntax,
  checker: CheckerLike,
  emitComponentCall: TS.CallExpression,
  elementTypeToTag: Map<string, string>,
): string | null {
  const symbol = getComponentSymbolFromEmitCall(ts, checker, emitComponentCall);
  if (!symbol) return null;
  const declarations = ts.declarations(symbol);
  for (const decl of declarations) {
    if (!ts.isVariableDeclaration(decl)) continue;
    // Form A: `const X: TOC<S> = ...;` — type annotation is `TOC<S>`.
    // Form B: `const X = <template>...</template> satisfies TOC<S>;` — the
    // initializer is a SatisfiesExpression whose `.type` is `TOC<S>`.
    // For both: locate the `TOC<…>` TypeReference, pull its first type
    // argument (S), then read S['Element'].
    let tocTypeNode: TS.TypeNode | undefined;
    if (decl.type) tocTypeNode = decl.type;
    else if (decl.initializer && ts.isSatisfiesExpression(decl.initializer)) {
      tocTypeNode = decl.initializer.type;
    }
    if (!tocTypeNode || !ts.isTypeReferenceNode(tocTypeNode)) continue;
    if (!isTOCTypeName(ts, tocTypeNode.typeName)) continue;
    const typeArgNode = tocTypeNode.typeArguments?.[0];
    if (!typeArgNode) continue;
    const sigType = checker.getTypeFromTypeNode(typeArgNode);
    const eltSym = sigType.getProperty('Element');
    if (!eltSym) continue;
    const eltType = checker.getTypeOfSymbolAtLocation(eltSym, typeArgNode);
    if (eltType.flags & ts.TypeFlags.Unknown) return 'transparent';
    const tag = matchElementTypeToTag(ts, eltType, elementTypeToTag);
    if (tag !== null) return tag;
  }
  return null;
}

// Recognize the bare type name `TOC` (and `TemplateOnlyComponent`, the
// long-form alias both `@ember/component/template-only` and
// `@glint/template/-private` re-export). Also handles qualified names like
// `Ember.TOC` — for those we match the rightmost identifier (`name.right`),
// since that's the actual type name. Doesn't follow imports: a project
// that aliases TOC to something else won't be resolved, which is fine —
// the component falls back to transparent.
function isTOCTypeName(ts: TsSyntax, name: TS.EntityName): boolean {
  let id: TS.Identifier;
  if (ts.isIdentifier(name)) id = name;
  else if (ts.isQualifiedName(name)) id = name.right;
  else return false;
  return id.text === 'TOC' || id.text === 'TemplateOnlyComponent';
}
function describeType(ts: TsSyntax, checker: CheckerLike, type: TypeLike): AttrTypeInfo {
  const literal = ts.stringLiteralValue(type);
  if (literal !== null) {
    return { kind: 'string-literal', values: [literal] };
  }
  const members = ts.unionMembers(type);
  if (members) {
    const values = members.map((member) => ts.stringLiteralValue(member));
    if (values.every((value): value is string => value !== null)) {
      return { kind: 'string-literal-union', values };
    }
  }
  return { kind: 'other', text: checker.typeToString(type) };
}

function isDslCall(ts: TsSyntax, node: TS.Node, names: readonly string[]): node is TS.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    names.includes(node.expression.name.text)
  );
}

// For a given mustache range in the transformed text, find the TS AST node
// and resolve its type. Glint's mapping range covers the whole
// `__glintDSL__.resolveOrReturn(__glintRef__.args.X)()` expression; we want
// the inner argument (the actual user-typed expression).
function findInnerTypeAtRange(
  ts: TsSyntax,
  sourceFile: TS.SourceFile,
  checker: CheckerLike,
  range: VirtualRange,
): TypeLike | null {
  // The expression covering the range is typically a CallExpression
  // shaped like `__glintDSL__.resolveOrReturn(<inner>)()`. We want the
  // <inner> argument's type. Strategy: find the deepest node whose start
  // falls within `range`, walk back up to its enclosing CallExpression of
  // resolveOrReturn / resolve, and read its first argument.
  let candidate: TS.Node | undefined;
  let innermost: TS.Node | undefined;
  function visit(node: TS.Node): void {
    const start = node.getStart();
    const end = node.getEnd();
    if (end <= range.start || start >= range.end) {
      return;
    }
    if (start >= range.start && end <= range.end && ts.isCallExpression(node)) {
      candidate = node;
    }
    if (start <= range.start && end >= range.end) {
      innermost = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!candidate) {
    // A range mapped from the template's own text (TypeScript 7's span
    // map) covers only the user expression, not the DSL wrapper around
    // it. Climb from the innermost node to the wrapper and retry on the
    // wrapper's full range so both mappings resolve the same node.
    let wrapper: TS.Node | undefined;
    for (let node = innermost; node && !wrapper; node = node.parent) {
      // `resolve(eq)(a, b)`: the DSL call is the callee, not an ancestor.
      let callee: TS.Node = node;
      while (ts.isCallExpression(callee) && ts.isCallExpression(callee.expression)) {
        callee = callee.expression;
      }
      if (isDslCall(ts, callee, ['resolveOrReturn', 'resolve'])) {
        wrapper = callee;
      }
    }
    if (!wrapper) {
      return null;
    }
    while (wrapper.parent && ts.isCallExpression(wrapper.parent) && wrapper.parent.expression === wrapper) {
      wrapper = wrapper.parent;
    }
    const wrapperRange = { start: wrapper.getStart(), end: wrapper.getEnd() };
    if (wrapperRange.start === range.start && wrapperRange.end === range.end) {
      return null;
    }
    return findInnerTypeAtRange(ts, sourceFile, checker, wrapperRange);
  }
  // Walk up to find a CallExpression whose callee is `resolveOrReturn` or
  // `resolve` — the @glint/ember-tsc DSL functions that wrap the inner
  // user expression.
  let cur: TS.Node | undefined = candidate;
  while (cur) {
    if (isDslCall(ts, cur, ['resolveOrReturn', 'resolve'])) {
      const inner = cur.arguments[0];
      if (inner) {
        return checker.getTypeAtLocation(inner);
      }
    }
    cur = cur.parent;
  }
  // Fallback: just type the candidate itself.
  return checker.getTypeAtLocation(candidate);
}

/**
 * Extract a map of attribute-value MustacheStatement positions to TS type
 * info for the given .gts file. Returns null if no type backend is
 * available or the project doesn't have a tsconfig.
 *
 * Map keys are `"line:column"` tuples (template-relative — Glimmer's
 * AST loc convention) so blank.ts can look up by Glimmer node loc.
 */
export function extractAttrTypeMap(filename: string, contents: string): ExtractionResult | null {
  const backend = backendFor(filename);
  if (!backend) {
    return null;
  }
  const { tsconfigPath, syntax: ts } = backend;

  // Disk-cache fast path. The extraction result is a pure function of
  // (file content + tsconfig content + backend + plugin version) — repeat
  // runs (CI, pre-commit, IDE re-validation on unchanged files) skip the
  // entire pipeline. See `lib/cache.ts`.
  const cached = readCache(filename, contents, tsconfigPath, backend.kind);
  if (cached) {
    return cached;
  }

  const opened = backend.open(filename, contents);
  if (opened === null) {
    return null;
  }
  if (opened === 'no-template') {
    // Negative cache: a file with no `<template>` block has a stable "no
    // Glint output" result for this (content + tsconfig + plugin
    // version). Cache it so subsequent calls hit cache instead of
    // retrying the rewrite.
    const empty: ExtractionResult = {
      attrTypeMap: new Map(),
      componentTagMap: new Map(),
      componentAttrMap: new Map(),
    };
    writeCache(filename, contents, tsconfigPath, backend.kind, empty);
    return empty;
  }
  const { sourceFile, checker, program, sites } = opened;

  const attrTypeMap = new Map<string, AttrTypeInfo>();
  const componentTagMap = new Map<string, string>();
  const componentAttrMap = new Map<string, ComponentAttrs>();
  // Per-invocation consumer-side info: @args (for arg propagation) and
  // dotted-binding context (for `<S.Step>` curried-via-yield-hash
  // resolution).
  const { argsByLoc: consumerArgsByLoc, dottedBindings, ownLetElementByLoc } = buildConsumerInfo(
    filename,
    contents,
  );
  // Populated as we resolve binder invocations while walking the sites.
  // Keys by binder's line:col; value is its TemplateSource. Lets dotted-
  // child resolution reach binders defined in the consumer file
  // itself (no import to follow).
  // For each dotted-binding chain hop we cache the parent's TemplateSource
  // AND any curried args picked up at that hop (e.g.
  // `Title=(component Inner size="300")` contributes `size="300"`).
  // Without persisting curriedArgs across hops, multi-level dotted
  // chains lose the curry's literals and the inner's destructure
  // defaults win instead.
  const binderSourceByKey = new Map<
    string,
    { source: ReturnType<typeof findTemplateSource>; curriedArgs: Map<string, string> }
  >();
  if (!backend.elementTypeToTag) {
    backend.elementTypeToTag = buildElementTypeToTag(ts, program);
  }
  const elementTypeToTag = backend.elementTypeToTag;

  for (const site of sites) {
    // Attribute-value mustache → TS type lookup.
    if (site.kind === 'attr-mustache') {
      const type = findInnerTypeAtRange(ts, sourceFile, checker, site.range);
      if (type) {
        attrTypeMap.set(site.key, describeType(ts, checker, type));
      }
      continue;
    }

    // PascalCase component invocation → resolve via Glint's emitComponent
    // call. The site is the component's tag-name reference; the enclosing
    // emitComponent call is what Glint emitted for this invocation. Read
    // its return-type's `.element` property.
    const key = site.key;
    const emitCall = findEnclosingEmitComponent(ts, sourceFile, site.range);
    const tag = emitCall ? resolveComponentElement(ts, checker, emitCall, elementTypeToTag) : null;
    if (tag) {
      componentTagMap.set(key, tag);
    }
    // Run the canonical resolver: walks the component's template AST,
    // handles polymorphic-tag chain, PascalCase wrapper recursion,
    // conditional convergence, and yield-ancestor analysis in one
    // pass. Replaces the previous six-path resolution sprawl
    // (leaf-fallback, outer-wrapper override, polymorphic chain,
    // classic-.hbs fallback, import-based outer-wrapper fallback,
    // dual-tag heuristic).
    if (!emitCall) continue;
    const declFile = findComponentDeclSourceFile(ts, checker, emitCall);
    // Skip the same-package outer-wrapper override when the
    // declaration ISN'T a top-level statement in `declFile` —
    // typically a let-block-param (`{{let @x as |Group|}}` becomes
    // `const [Group] = ...` inside the template-to-typescript
    // output). For these, declFile is the consumer file and
    // walking its outer `<template>` block returns whatever
    // happens to be at the file's root (often unrelated to what
    // `Group` actually renders).
    const symbol = getComponentSymbolFromEmitCall(ts, checker, emitCall);
    const decl = symbol ? ts.declarations(symbol)[0] : undefined;
    const isTopLevel = decl ? isTopLevelDeclaration(ts, decl) : false;
    const componentName = site.tag;

    // Dotted invocation `<S.Step>` from a `<Binder as |S|>` block:
    // resolve via the binder's `{{yield (hash Step=...)}}` chain.
    //
    // Nested-dotted chains (HDS form-layout shape:
    // `<HdsForm as |FORM|><FORM.Section as |FS|>
    //  <FS.Header as |FSH|><FSH.Title>...`) — when the binder
    // itself is a dotted tag (e.g. `FS.Header`), the importable
    // root lives multiple hops up. Walk `binderSourceByKey` (now
    // populated for dotted invocations too, see below) to find
    // the parent's TemplateSource directly.
    const dottedBinding = dottedBindings.get(key);
    if (dottedBinding) {
      const cachedBinder = binderSourceByKey.get(dottedBinding.binderKey);
      let binderSource = cachedBinder?.source ?? null;
      const cachedCurriedArgs = cachedBinder?.curriedArgs ?? new Map<string, string>();
      if (!binderSource) {
        binderSource = findTemplateSource({
          consumerFile: filename,
          componentName: dottedBinding.binderTag,
          ts,
        });
      }
      if (binderSource) {
        // Args available at this hop, in increasing-priority order:
        //   1. binderArgs (`<Binder @x="y" as |S|>` → consumer's
        //      args on the outermost binder)
        //   2. cachedCurriedArgs (curry literals collected at any
        //      earlier hop, e.g. `(component Inner size="300")`)
        //   3. invocation args on the dotted call itself
        //      (`<S.Step @tag="li">`) — these should win against
        //      curry/binder defaults since the consumer set them
        //      most directly.
        const invocationArgs = consumerArgsByLoc.get(key) ?? new Map();
        const mergedArgs = new Map<string, string>([
          ...dottedBinding.binderArgs,
          ...cachedCurriedArgs,
          ...invocationArgs,
        ]);
        const resolution = resolveYieldHashBinding({
          parentSource: binderSource,
          hashKey: dottedBinding.hashKey,
          parentArgs: mergedArgs,
          ts,
        });
        applyResolution(componentTagMap, componentAttrMap, key, resolution);
        // Cache the SOURCE that this dotted invocation yields,
        // so children whose binder is this dotted invocation
        // (`<FS.Header>` whose binder is `<FORM.Section>`) can
        // chain through to the next level without re-walking
        // from the importable root. Also persist curriedArgs so
        // the next-level hop can incorporate `(component Inner
        // size="300")` literals into its mergedArgs.
        const nextSource = resolveYieldHashBindingSource({
          parentSource: binderSource,
          hashKey: dottedBinding.hashKey,
          parentArgs: mergedArgs,
          ts,
        });
        if (nextSource) {
          const accumulatedCurried = new Map([
            ...cachedCurriedArgs,
            ...nextSource.curriedArgs,
          ]);
          binderSourceByKey.set(key, { source: nextSource.source, curriedArgs: accumulatedCurried });
        }
      }
    } else if (declFile && isTopLevel) {
      // Skip non-top-level decls (let-block-params): walking their
      // declaring file's template returns whatever's at the file's
      // root, unrelated to what the binding renders.
      const declRange = decl ? opened.originalRange(decl) : null;
      const source = findTemplateSource({
        declFile,
        declRange,
        consumerFile: filename,
        componentName,
        ts,
      });
      // Cache for any dotted-children that name this invocation as
      // their binder. Accept null too — a transparent binder result
      // still belongs to this invocation, no point re-querying. No
      // curried args at this level: this is a direct (non-dotted)
      // invocation whose binder is its own template.
      binderSourceByKey.set(key, { source, curriedArgs: new Map() });
      if (source) {
        const consumerArgs = consumerArgsByLoc.get(key) ?? new Map();
        const resolution = resolveTemplate(source, { consumerArgs, ts });
        applyResolution(componentTagMap, componentAttrMap, key, resolution);
      }
    } else {
      // Cross-package barrel: TS resolved through a re-export and
      // we can't reach the source via decl. Fall back to consumer-
      // side import resolution.
      const source = findTemplateSource({
        consumerFile: filename,
        componentName,
        ts,
      });
      if (source) {
        const consumerArgs = consumerArgsByLoc.get(key) ?? new Map();
        const resolution = resolveTemplate(source, { consumerArgs, ts });
        applyResolution(componentTagMap, componentAttrMap, key, resolution);
      }
    }
  }

  // Override Glint's TS-side fallback for `<T>` elements bound by
  // `{{#let (element this.X) as |T|}}` in the consumer's OWN template.
  // For these, Glint's TS-side picks the first matching union member
  // from `(element …)`'s return type (typically <h1> from
  // HTMLHeadingElement) — but the actual runtime tag is the class
  // getter's value (typically 'div' from a `?? DEFAULT_TAG` default).
  // resolveThisProp walks the consumer file's class body to find the
  // getter's return literal.
  if (ownLetElementByLoc.size > 0) {
    const ownSource: TemplateSource = {
      origin: filename,
      content: '',
      kind: filename.endsWith('.gjs') ? 'gjs' : 'gts',
    };
    for (const [key, propName] of ownLetElementByLoc) {
      const literal = resolveThisProp(ownSource, propName, { ts });
      if (!literal || !isNativeTag(literal)) continue;
      componentTagMap.set(key, literal);
      componentAttrMap.set(key, {
        tag: literal,
        attrs: {},
        // `<T ...attributes>` is the canonical shape for this pattern;
        // attribute injection / aria-strip can operate on the splatted
        // tag like any other resolved component.
        hasSplat: true,
      });
    }
  }

  const result: ExtractionResult = { attrTypeMap, componentTagMap, componentAttrMap };
  writeCache(filename, contents, tsconfigPath, backend.kind, result);
  return result;
}

// Recover the de-aliased symbol of the component invoked by an
// emitComponent call. Glint's rewrite emits invocations as
//   __glintDSL__.emitComponent(__glintDSL__.resolve(Comp)({...}))
// so we navigate the AST: emitCall.arguments[0] is the resolve()(...)
// call, whose expression is resolve(Comp), whose first argument is the
// component reference. Aliased imports (the common case) are de-aliased
// via `checker.getAliasedSymbol` to land on the original declaration.
//
// Shared by `findComponentDeclSourceFile` and
// `resolveElementFromTOCDeclaration` — they both need the same symbol;
// keeping the AST navigation in one place means callers stay in sync if
// Glint's emitted shape changes.
function getComponentSymbolFromEmitCall(
  ts: TsSyntax,
  checker: CheckerLike,
  emitCall: TS.CallExpression,
): SymbolLike | null {
  const innerCall = emitCall.arguments[0];
  if (!innerCall || !ts.isCallExpression(innerCall)) return null;
  const resolveCall = innerCall.expression;
  if (!ts.isCallExpression(resolveCall)) return null;
  const componentRef = resolveCall.arguments[0];
  if (!componentRef) return null;
  let symbol = checker.getSymbolAtLocation(componentRef);
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

// Resolve the source file containing a component's declaration.
function findComponentDeclSourceFile(
  ts: TsSyntax,
  checker: CheckerLike,
  emitCall: TS.CallExpression,
): string | null {
  const symbol = getComponentSymbolFromEmitCall(ts, checker, emitCall);
  const decl = symbol ? ts.declarations(symbol)[0] : undefined;
  if (!decl) return null;
  return decl.getSourceFile().fileName;
}

// True when the component reference's declaration is a top-level
// statement in its source file (e.g. `const X: TOC<S> = <template>`),
// rather than an inner-scope binding (e.g. a let-block-param emitted
// as `const [Group] = ...` inside the template-to-typescript output).
//
// Why we need this: the outer-wrapper override walks the declaration
// file's first `<template>` block to find a wrapping native tag.
// That's correct for top-level component declarations whose template
// IS the file's first block, but produces wrong results for inner-
// scope bindings — a `{{let @groupComponent as |Group|}}` would resolve
// `<Group>`'s declFile back to the consumer file, and walking the
// consumer's first `<template>` block returns whatever wrapper
// happens to be there (often `<ul>` for a power-select-options-style
// recursive template), not what `Group` actually renders.
function isTopLevelDeclaration(ts: TsSyntax, decl: TS.Declaration): boolean {
  // VariableDeclaration → VariableDeclarationList → VariableStatement
  // → SourceFile (when top-level).
  // ClassDeclaration / FunctionDeclaration etc. → directly child of
  // SourceFile.
  let node: TS.Node | undefined = decl;
  while (node) {
    if (
      node.kind === ts.SyntaxKind.VariableStatement ||
      node.kind === ts.SyntaxKind.ClassDeclaration ||
      node.kind === ts.SyntaxKind.FunctionDeclaration ||
      node.kind === ts.SyntaxKind.InterfaceDeclaration ||
      node.kind === ts.SyntaxKind.TypeAliasDeclaration ||
      node.kind === ts.SyntaxKind.ExportAssignment
    ) {
      // Only top-level if the parent IS the SourceFile.
      return node.parent?.kind === ts.SyntaxKind.SourceFile;
    }
    node = node.parent;
  }
  return false;
}

// Find the `__glintDSL__.emitComponent(...)` CallExpression that contains
// the given range (which corresponds to a component's PathExpression in
// the original template). Glint emits component invocations as
// `emitComponent(__glintDSL__.resolve(Comp)({...}))`, and the surrounding
// emitComponent's return type carries the rendered Element type.
function findEnclosingEmitComponent(
  ts: TsSyntax,
  sourceFile: TS.SourceFile,
  range: VirtualRange,
): TS.CallExpression | null {
  let result: TS.CallExpression | undefined;
  function visit(node: TS.Node): void {
    const start = node.getStart();
    const end = node.getEnd();
    if (end <= range.start || start >= range.end) {
      return;
    }
    if (isDslCall(ts, node, ['emitComponent']) && start <= range.start && end >= range.end) {
      // Overwrite with each deeper match so we end up with the innermost
      // emitComponent call that contains the range.
      result = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result ?? null;
}
