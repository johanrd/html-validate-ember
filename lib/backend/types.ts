// The type-information backend behind Glint extraction.
//
// Two implementations produce the same shapes:
//   - `ts6`: TypeScript 5/6 as an in-process library plus Glint's
//     `rewriteModule` (the original pipeline).
//   - `tsgo`: TypeScript 7's synchronous IPC API (`typescript/unstable/sync`)
//     against a project whose tsconfig declares `contentMappers`, so the
//     `.gts` transform already happened inside the compiler.
//
// The extraction algorithm in `lib/glint.ts` and the syntactic walks in
// `lib/resolver/` only see these interfaces. Node and type objects are
// typed with TypeScript's own `typescript` types: both backends expose
// the same member names (`kind`, `parent`, `getStart()`, `arguments`,
// …), so the structural types hold for either at runtime.

import type * as TS from 'typescript';

/** Numeric enum values differ between TypeScript 6 and typescript-go;
 *  compare against the backend's tables, never against a literal. */
export interface SyntaxTables {
  readonly SyntaxKind: {
    readonly ClassDeclaration: number;
    readonly ExportAssignment: number;
    readonly FunctionDeclaration: number;
    readonly InterfaceDeclaration: number;
    readonly ObjectLiteralExpression: number;
    readonly QuestionQuestionToken: number;
    readonly SourceFile: number;
    readonly ThisKeyword: number;
    readonly TypeAliasDeclaration: number;
    readonly VariableStatement: number;
  };
  readonly TypeFlags: { readonly Any: number; readonly Unknown: number; readonly Null: number };
  readonly SymbolFlags: { readonly Alias: number };
  readonly ObjectFlags: { readonly Reference: number };
}

export interface TypeLike {
  readonly flags: number;
  readonly objectFlags?: number;
  getSymbol(): SymbolLike | undefined;
  getProperty(name: string): SymbolLike | undefined;
}

export interface SymbolLike {
  readonly name: string;
  readonly flags: number;
}

export interface CheckerLike {
  getTypeAtLocation(node: TS.Node): TypeLike;
  getSymbolAtLocation(node: TS.Node): SymbolLike | undefined;
  getAliasedSymbol(symbol: SymbolLike): SymbolLike;
  getTypeOfSymbolAtLocation(symbol: SymbolLike, location: TS.Node): TypeLike;
  getTypeFromTypeNode(node: TS.TypeNode): TypeLike;
  getTypeArguments(type: TypeLike): readonly TypeLike[];
  typeToString(type: TypeLike): string;
}

export interface ProgramLike {
  getSourceFile(fileName: string): TS.SourceFile | undefined;
  getSourceFileNames(): readonly string[];
}

/** The subset of the `typescript` module the syntactic walks use. */
export interface TsSyntax extends SyntaxTables {
  parseFile(fileName: string, contents: string, kind: 'ts' | 'js'): TS.SourceFile;
  forEachChild(node: TS.Node, visit: (node: TS.Node) => void): void;
  isBinaryExpression(node: TS.Node): node is TS.BinaryExpression;
  isCallExpression(node: TS.Node): node is TS.CallExpression;
  isClassDeclaration(node: TS.Node): node is TS.ClassDeclaration;
  isClassExpression(node: TS.Node): node is TS.ClassExpression;
  isEnumDeclaration(node: TS.Node): node is TS.EnumDeclaration;
  isExportDeclaration(node: TS.Node): node is TS.ExportDeclaration;
  isGetAccessor(node: TS.Node): node is TS.GetAccessorDeclaration;
  isIdentifier(node: TS.Node): node is TS.Identifier;
  isImportDeclaration(node: TS.Node): node is TS.ImportDeclaration;
  isInterfaceDeclaration(node: TS.Node): node is TS.InterfaceDeclaration;
  isNamedExports(node: TS.Node): node is TS.NamedExports;
  isNamedImports(node: TS.Node): node is TS.NamedImports;
  isObjectBindingPattern(node: TS.Node): node is TS.ObjectBindingPattern;
  isPropertyAccessExpression(node: TS.Node): node is TS.PropertyAccessExpression;
  isPropertyDeclaration(node: TS.Node): node is TS.PropertyDeclaration;
  isPropertySignature(node: TS.Node): node is TS.PropertySignature;
  isQualifiedName(node: TS.Node): node is TS.QualifiedName;
  isReturnStatement(node: TS.Node): node is TS.ReturnStatement;
  isSatisfiesExpression(node: TS.Node): node is TS.SatisfiesExpression;
  isStringLiteral(node: TS.Node): node is TS.StringLiteral;
  isStringLiteralLike(node: TS.Node): node is TS.StringLiteralLike;
  isTypeReferenceNode(node: TS.Node): node is TS.TypeReferenceNode;
  isVariableDeclaration(node: TS.Node): node is TS.VariableDeclaration;
  isVariableStatement(node: TS.Node): node is TS.VariableStatement;
  /** Declarations of a symbol, in declaration order. */
  declarations(symbol: SymbolLike): readonly TS.Declaration[];
  /** Type arguments of a type-alias instantiation such as `TOC<Sig>`. */
  aliasTypeArguments(type: TypeLike): readonly TypeLike[] | undefined;
  /** Members of a union type; null when `type` is not a union. */
  unionMembers(type: TypeLike): readonly TypeLike[] | null;
  /** The value of a string-literal type; null for any other type. */
  stringLiteralValue(type: TypeLike): string | null;
}

export interface VirtualRange {
  start: number;
  end: number;
}

/**
 * A template construct with its range in the transformed (virtual) TypeScript,
 * in document order. Keys are template-relative `line:column` of the Glimmer
 * node, matching `blank.ts` lookups.
 */
export type TemplateSite =
  | { kind: 'attr-mustache'; key: string; range: VirtualRange }
  | { kind: 'component'; key: string; tag: string; range: VirtualRange };

export interface OpenedFile {
  sourceFile: TS.SourceFile;
  checker: CheckerLike;
  program: ProgramLike;
  sites: readonly TemplateSite[];
  /** Range of a declaration in its file's original text (the `.gts` on disk). */
  originalRange(node: TS.Node): VirtualRange;
}

export interface PreloadProgress {
  done: number;
  total: number;
  phase: 'rewrite' | 'program' | 'done';
}

export interface SkipEntry {
  file: string;
  message?: string;
}

export interface PreloadStats {
  backend?: 'ts6' | 'tsgo';
  loaded: number;
  cached: number;
  skipped: number;
  skips: {
    nonGts: SkipEntry[];
    readError: SkipEntry[];
    rewriteError: SkipEntry[];
    rewriteEmpty: SkipEntry[];
  };
}

export interface TypeBackend {
  readonly kind: 'ts6' | 'tsgo';
  readonly tsconfigPath: string;
  readonly projectRoot: string;
  readonly syntax: TsSyntax;
  /** Lazily built `HTMLElementTagNameMap` reverse index, shared per project. */
  elementTypeToTag?: Map<string, string>;
  preload(filenames: readonly string[], onProgress?: (p: PreloadProgress) => void): PreloadStats;
  /**
   * `null` when the file cannot be served; `'no-template'` when it has no
   * `<template>` (nothing to extract).
   */
  open(filename: string, contents: string): OpenedFile | 'no-template' | null;
  /** Release the compiler process and its snapshots. A CLI run can rely on process exit instead. */
  dispose(): void;
}
