// TypeScript 7 backend: `typescript/unstable/sync`, the synchronous IPC
// API of the Go compiler. The project is opened with `runExternalCode`
// so the tsconfig's `contentMappers` (ember-content-mapper) transform
// `.gts` files inside the compiler; `getSourceFile('x.gts')` returns
// the transformed text and `spanMap` maps it back to the template.
//
// No Glint rewrite and no `typescript` library run in this process. The
// resolver's syntactic parses go through the same API: the text is
// served from an in-memory overlay and opened as a file of an inferred
// project. Node objects decoded from a snapshot stay readable after the
// snapshot is disposed; type and symbol handles do not.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';

import { Preprocessor } from 'content-tag';
import { preprocess as glimmerPreprocess, type AST } from '@glimmer/syntax';

import { isComponentTag } from '../../blank.js';
import { readCache, writeCache } from '../cache.js';
import { ts6Syntax } from './ts6.js';
import type {
  CheckerLike,
  OpenedFile,
  PreloadProgress,
  PreloadStats,
  SymbolLike,
  TemplateSite,
  TsSyntax,
  TypeBackend,
  TypeLike,
  VirtualRange,
} from './types.js';

// Minimal local typing for the `typescript/unstable/*` surface we use.
// The package is a peer that consumers install under a name of their
// choosing (see `loadTsgo`), so nothing here imports its types.
interface TsgoSpanSegment {
  readonly virtualStart: number;
  readonly virtualEnd: number;
  readonly originalStart: number;
  readonly originalEnd: number;
  readonly kind: number;
}
interface TsgoSpanMap {
  readonly segments: readonly TsgoSpanSegment[];
}
interface TsgoSourceFile {
  readonly fileName: string;
  readonly text: string;
  readonly contentMapper?: string;
  readonly spanMap?: TsgoSpanMap;
}
interface TsgoProgram {
  getSourceFile(fileName: string): TsgoSourceFile | undefined;
  getSourceFileNames(): readonly string[];
}
interface TsgoProject {
  readonly configFileName: string;
  readonly program: TsgoProgram;
  readonly checker: unknown;
}
interface TsgoSnapshot {
  getDefaultProjectForFile(file: string): TsgoProject | undefined;
  dispose(): void;
}
interface TsgoFileSystem {
  readFile(fileName: string): string | undefined;
  fileExists(fileName: string): boolean;
  directoryExists(directoryName: string): boolean;
  getAccessibleEntries(directoryName: string): { files: string[]; directories: string[] };
  realpath(p: string): string;
}
interface TsgoUpdateSnapshotParams {
  openProjects?: readonly string[];
  openFiles?: readonly string[];
  closeFiles?: readonly string[];
  fileChanges?: { changed?: string[]; created?: string[]; deleted?: string[] };
}
interface TsgoApi {
  updateSnapshot(params?: TsgoUpdateSnapshotParams): TsgoSnapshot;
  close(): void;
}
interface TsgoSyncModule {
  API: new (options: { cwd: string; runExternalCode?: boolean; fs?: TsgoFileSystem }) => TsgoApi;
  TypeFlags: { Any: number; Unknown: number; Null: number };
  SymbolFlags: { Alias: number };
  ObjectFlags: { Reference: number };
}
interface TsgoAstModule {
  SyntaxKind: { readonly [name: string]: number | string | undefined };
  SpanMapKind: { Verbatim: number };
}
interface TsgoType extends TypeLike {
  isUnionType(): boolean;
  getTypes(): readonly TypeLike[];
  getAliasTypeArguments(): readonly TypeLike[];
  isStringLiteralType(): boolean;
  readonly value?: unknown;
}
interface TsgoSymbol extends SymbolLike {
  readonly declarations: readonly { resolve(): unknown }[];
}
export interface TsgoModules {
  packageName: string;
  version: string;
  sync: TsgoSyncModule;
  ast: TsgoAstModule;
}

const CANDIDATE_PACKAGES = ['typescript', '@typescript/native', 'typescript-7', '@typescript/native-preview'];

const modulesByRoot = new Map<string, TsgoModules | null>();

/**
 * Find a TypeScript 7 package installed in the project. `typescript` itself
 * when it is 7.x, otherwise the aliases projects use to run 7 next to a
 * library-API 5/6 (`HVE_TSGO=<package name>` overrides the search).
 * Requires Node 22.12+ (`require()` of the ESM API).
 */
export function loadTsgo(projectRoot: string): TsgoModules | null {
  const cached = modulesByRoot.get(projectRoot);
  if (cached !== undefined) return cached;
  const req = createRequire(path.join(projectRoot, 'package.json'));
  const override = process.env['HVE_TSGO'];
  const candidates = override ? [override] : CANDIDATE_PACKAGES;
  let found: TsgoModules | null = null;
  for (const name of candidates) {
    try {
      const pkg = req(`${name}/package.json`) as { version?: string };
      const version = pkg.version ?? '0';
      if (Number.parseInt(version, 10) < 7) continue;
      const sync = req(`${name}/unstable/sync`) as TsgoSyncModule;
      const ast = req(`${name}/unstable/ast`) as TsgoAstModule;
      found = { packageName: name, version, sync, ast };
      break;
    } catch {
      // not installed under this name, or not requirable — try the next
    }
  }
  modulesByRoot.set(projectRoot, found);
  return found;
}

// The project's `typescript` 5/6 library, if installed: a syntactic parse
// in-process is ~1 ms; through tsgo it is two snapshot round-trips.
function libraryTypeScript(projectRoot: string): TsSyntax | null {
  try {
    const ts = createRequire(path.join(projectRoot, 'package.json'))('typescript') as typeof TS;
    return typeof ts.createSourceFile === 'function' ? ts6Syntax(ts) : null;
  } catch {
    return null;
  }
}

function kindTable(ast: TsgoAstModule, name: string): number {
  const value = ast.SyntaxKind[name];
  if (typeof value !== 'number') {
    throw new Error(`typescript-go SyntaxKind has no member '${name}'`);
  }
  return value;
}

function tsgoSyntax(mods: TsgoModules, parseFile: TsSyntax['parseFile']): TsSyntax {
  const kind = (name: string) => kindTable(mods.ast, name);
  const guard = <T extends TS.Node>(kindName: string) => {
    const k = kind(kindName);
    return (node: TS.Node): node is T => node.kind === k;
  };
  const stringLiteral = kind('StringLiteral');
  const noSubstitutionTemplateLiteral = kind('NoSubstitutionTemplateLiteral');
  return {
    SyntaxKind: {
      ClassDeclaration: kind('ClassDeclaration'),
      ExportAssignment: kind('ExportAssignment'),
      FunctionDeclaration: kind('FunctionDeclaration'),
      InterfaceDeclaration: kind('InterfaceDeclaration'),
      ObjectLiteralExpression: kind('ObjectLiteralExpression'),
      QuestionQuestionToken: kind('QuestionQuestionToken'),
      SourceFile: kind('SourceFile'),
      ThisKeyword: kind('ThisKeyword'),
      TypeAliasDeclaration: kind('TypeAliasDeclaration'),
      VariableStatement: kind('VariableStatement'),
    },
    TypeFlags: mods.sync.TypeFlags,
    SymbolFlags: mods.sync.SymbolFlags,
    ObjectFlags: mods.sync.ObjectFlags,
    parseFile,
    forEachChild: (node, visit) => {
      node.forEachChild(visit);
    },
    isBinaryExpression: guard<TS.BinaryExpression>('BinaryExpression'),
    isCallExpression: guard<TS.CallExpression>('CallExpression'),
    isClassDeclaration: guard<TS.ClassDeclaration>('ClassDeclaration'),
    isClassExpression: guard<TS.ClassExpression>('ClassExpression'),
    isEnumDeclaration: guard<TS.EnumDeclaration>('EnumDeclaration'),
    isExportDeclaration: guard<TS.ExportDeclaration>('ExportDeclaration'),
    isGetAccessor: guard<TS.GetAccessorDeclaration>('GetAccessor'),
    isIdentifier: guard<TS.Identifier>('Identifier'),
    isImportDeclaration: guard<TS.ImportDeclaration>('ImportDeclaration'),
    isInterfaceDeclaration: guard<TS.InterfaceDeclaration>('InterfaceDeclaration'),
    isNamedExports: guard<TS.NamedExports>('NamedExports'),
    isNamedImports: guard<TS.NamedImports>('NamedImports'),
    isObjectBindingPattern: guard<TS.ObjectBindingPattern>('ObjectBindingPattern'),
    isPropertyAccessExpression: guard<TS.PropertyAccessExpression>('PropertyAccessExpression'),
    isPropertyDeclaration: guard<TS.PropertyDeclaration>('PropertyDeclaration'),
    isPropertySignature: guard<TS.PropertySignature>('PropertySignature'),
    isQualifiedName: guard<TS.QualifiedName>('QualifiedName'),
    isReturnStatement: guard<TS.ReturnStatement>('ReturnStatement'),
    isSatisfiesExpression: guard<TS.SatisfiesExpression>('SatisfiesExpression'),
    isStringLiteral: guard<TS.StringLiteral>('StringLiteral'),
    isStringLiteralLike: (node: TS.Node): node is TS.StringLiteralLike =>
      node.kind === stringLiteral || node.kind === noSubstitutionTemplateLiteral,
    isTypeReferenceNode: guard<TS.TypeReferenceNode>('TypeReference'),
    isVariableDeclaration: guard<TS.VariableDeclaration>('VariableDeclaration'),
    isVariableStatement: guard<TS.VariableStatement>('VariableStatement'),
    // Declarations arrive as lazy handles; resolving materializes the node
    // in the symbol's project. Same boundary as `parseFile`.
    declarations: (symbol: SymbolLike) =>
      (symbol as TsgoSymbol).declarations
        .map((handle) => handle.resolve())
        .filter((node): node is TS.Declaration => node !== undefined),
    aliasTypeArguments: (type: TypeLike) => (type as TsgoType).getAliasTypeArguments(),
    unionMembers: (type: TypeLike) => {
      const t = type as TsgoType;
      return t.isUnionType() ? t.getTypes() : null;
    },
    stringLiteralValue: (type: TypeLike) => {
      const t = type as TsgoType;
      return t.isStringLiteralType() && typeof t.value === 'string' ? t.value : null;
    },
  };
}

/** Virtual range covering the verbatim segments of an original range. */
function toVirtual(
  segments: readonly TsgoSpanSegment[],
  verbatim: number,
  original: VirtualRange,
): VirtualRange | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const s of segments) {
    if (s.kind !== verbatim || s.originalEnd <= original.start || s.originalStart >= original.end) continue;
    const offset = Math.max(original.start, s.originalStart) - s.originalStart;
    const length = Math.min(original.end, s.originalEnd) - Math.max(original.start, s.originalStart);
    start = Math.min(start, s.virtualStart + offset);
    end = Math.max(end, s.virtualStart + offset + length);
  }
  return start <= end ? { start, end } : null;
}

/** Original range covering the verbatim segments of a virtual range. */
function toOriginal(
  segments: readonly TsgoSpanSegment[],
  verbatim: number,
  virtual: VirtualRange,
): VirtualRange | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const s of segments) {
    if (s.kind !== verbatim || s.virtualEnd <= virtual.start || s.virtualStart >= virtual.end) continue;
    const offset = Math.max(virtual.start, s.virtualStart) - s.virtualStart;
    const length = Math.min(virtual.end, s.virtualEnd) - Math.max(virtual.start, s.virtualStart);
    start = Math.min(start, s.originalStart + offset);
    end = Math.max(end, s.originalStart + offset + length);
  }
  return start <= end ? { start, end } : null;
}

const preprocessor = new Preprocessor();

function locKey(line: number, column: number): string {
  return `${line}:${column}`;
}

// Sites in document order: an element before its attributes, parents
// before children — the order Glint's mapping tree visits them.
function collectSites(
  blocks: ReturnType<Preprocessor['parse']>,
  spanMap: TsgoSpanMap,
  verbatim: number,
): TemplateSite[] {
  const sites: TemplateSite[] = [];
  for (const block of blocks) {
    if (block.tagName !== 'template' || !block.contentRange) continue;
    const base = block.contentRange.startUtf16Codepoint;
    let ast: AST.Template;
    try {
      ast = glimmerPreprocess(block.contents, { mode: 'codemod' });
    } catch {
      continue;
    }
    const virtualOf = (loc: AST.Node['loc']): VirtualRange | null => {
      const start = loc.getStart().offset;
      const end = loc.getEnd().offset;
      if (start === null || end === null) return null;
      return toVirtual(spanMap.segments, verbatim, { start: base + start, end: base + end });
    };
    function walk(node: AST.Node): void {
      if (node.type === 'ElementNode') {
        const elementStart = node.loc.getStart().offset;
        if (isComponentTag(node.tag) && node.loc.start && elementStart !== null) {
          const tagStart = base + elementStart + 1;
          const range = toVirtual(spanMap.segments, verbatim, {
            start: tagStart,
            end: tagStart + node.tag.length,
          });
          if (range) {
            sites.push({
              kind: 'component',
              key: locKey(node.loc.start.line, node.loc.start.column),
              tag: node.tag,
              range,
            });
          }
        }
        for (const attr of node.attributes) {
          const value = attr.value;
          if (value.type !== 'MustacheStatement' || !value.loc.start) continue;
          const range = virtualOf(value.loc);
          if (range) {
            sites.push({
              kind: 'attr-mustache',
              key: locKey(value.loc.start.line, value.loc.start.column),
              range,
            });
          }
        }
        for (const child of node.children) walk(child);
        return;
      }
      if (node.type === 'BlockStatement') {
        for (const child of node.program.body) walk(child);
        if (node.inverse) for (const child of node.inverse.body) walk(child);
        return;
      }
      if (node.type === 'Template' || node.type === 'Block') {
        for (const child of node.body) walk(child);
      }
    }
    walk(ast);
  }
  return sites;
}

function templateBlocks(contents: string, filename: string): ReturnType<Preprocessor['parse']> {
  try {
    return preprocessor.parse(contents, { filename }).filter((b) => b.tagName === 'template');
  } catch {
    return [];
  }
}

export function createTsgoBackend(mods: TsgoModules, tsconfigPath: string): TypeBackend {
  const projectRoot = path.dirname(tsconfigPath);
  const verbatim = mods.ast.SpanMapKind.Verbatim;

  // In-memory files the compiler sees in front of disk: editor buffers
  // handed to `open`, and the resolver's stripped-template parses.
  const overlay = new Map<string, string>();
  const fileSystem: TsgoFileSystem = {
    readFile: (name) => {
      const v = overlay.get(name);
      if (v !== undefined) return v;
      try {
        return fs.readFileSync(name, 'utf8');
      } catch {
        return undefined;
      }
    },
    fileExists: (name) => overlay.has(name) || fs.existsSync(name),
    directoryExists: (name) => {
      try {
        return fs.statSync(name).isDirectory();
      } catch {
        return false;
      }
    },
    getAccessibleEntries: (name) => {
      const files: string[] = [];
      const directories: string[] = [];
      try {
        for (const entry of fs.readdirSync(name, { withFileTypes: true })) {
          if (entry.isDirectory()) directories.push(entry.name);
          else if (entry.isFile() || entry.isSymbolicLink()) files.push(entry.name);
        }
      } catch {
        // unreadable directory — report it empty
      }
      return { files, directories };
    },
    realpath: (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    },
  };

  let api: TsgoApi | null = null;
  let current: TsgoSnapshot | null = null;
  // Snapshots whose type handles may still be in use by the extraction
  // that was running when a newer snapshot was created; disposed at the
  // next `open`.
  const retired: TsgoSnapshot[] = [];

  function ensureApi(): TsgoApi {
    if (!api) {
      api = new mods.sync.API({ cwd: projectRoot, runExternalCode: true, fs: fileSystem });
    }
    return api;
  }

  function ensureSnapshot(): TsgoSnapshot {
    if (!current) {
      current = ensureApi().updateSnapshot({ openProjects: [tsconfigPath] });
    }
    return current;
  }

  function replaceSnapshot(params: TsgoUpdateSnapshotParams): TsgoSnapshot {
    const previous = ensureSnapshot();
    current = ensureApi().updateSnapshot(params);
    retired.push(previous);
    return current;
  }

  // One parse per virtual file name; a changed buffer replaces the entry.
  const parsedFiles = new Map<string, { contents: string; sourceFile: TS.SourceFile }>();

  function parseFile(fileName: string, contents: string, kind: 'ts' | 'js'): TS.SourceFile {
    // The name keeps the origin visible in diagnostics but must not be a
    // `.gts`/`.gjs` path, or the content mapper would transform it.
    const virtualName = `${fileName}.__hve.${kind}`;
    const cached = parsedFiles.get(virtualName);
    if (cached?.contents === contents) return cached.sourceFile;
    overlay.set(virtualName, contents);
    const snapshot = ensureApi().updateSnapshot({ openFiles: [virtualName] });
    const project = snapshot.getDefaultProjectForFile(virtualName);
    const sourceFile = project?.program.getSourceFile(virtualName);
    if (!sourceFile) {
      snapshot.dispose();
      throw new Error(`typescript-go did not open ${virtualName}`);
    }
    ensureApi().updateSnapshot({ closeFiles: [virtualName] }).dispose();
    snapshot.dispose();
    overlay.delete(virtualName);
    // Node data is decoded client-side and outlives the snapshot; this is
    // the boundary between typescript-go's AST and the `typescript` types
    // the walks are written against (same member names).
    const result = sourceFile as unknown as TS.SourceFile;
    parsedFiles.set(virtualName, { contents, sourceFile: result });
    return result;
  }

  const syntax = tsgoSyntax(mods, parseFile);
  const parserSyntax = libraryTypeScript(projectRoot) ?? syntax;

  function preload(filenames: readonly string[], onProgress?: (p: PreloadProgress) => void): PreloadStats {
    let loaded = 0;
    let cached = 0;
    const skips: PreloadStats['skips'] = {
      nonGts: [],
      readError: [],
      rewriteError: [],
      rewriteEmpty: [],
    };
    let done = 0;
    for (const filename of filenames) {
      done++;
      onProgress?.({ done, total: filenames.length, phase: 'rewrite' });
      if (!filename.endsWith('.gts') && !filename.endsWith('.gjs')) {
        skips.nonGts.push({ file: filename });
        continue;
      }
      let contents: string;
      try {
        contents = fs.readFileSync(filename, 'utf8');
      } catch (err) {
        skips.readError.push({
          file: filename,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (readCache(filename, contents, tsconfigPath, 'tsgo')) {
        cached++;
        continue;
      }
      if (templateBlocks(contents, filename).length === 0) {
        writeCache(filename, contents, tsconfigPath, 'tsgo', {
          attrTypeMap: new Map(),
          componentTagMap: new Map(),
          componentAttrMap: new Map(),
        });
        skips.rewriteEmpty.push({ file: filename });
        continue;
      }
      loaded++;
    }
    if (loaded > 0) {
      onProgress?.({ done: filenames.length, total: filenames.length, phase: 'program' });
      ensureSnapshot();
    }
    onProgress?.({ done: filenames.length, total: filenames.length, phase: 'done' });
    const skipped =
      skips.nonGts.length + skips.readError.length + skips.rewriteError.length + skips.rewriteEmpty.length;
    return { backend: 'tsgo', loaded, cached, skipped, skips };
  }

  function open(filename: string, contents: string): OpenedFile | 'no-template' | null {
    for (const snapshot of retired.splice(0)) snapshot.dispose();
    const blocks = templateBlocks(contents, filename);
    if (blocks.length === 0) {
      return 'no-template';
    }
    let onDisk: string | null = null;
    try {
      onDisk = fs.readFileSync(filename, 'utf8');
    } catch {
      // not on disk — served from the overlay below
    }
    let snapshot: TsgoSnapshot;
    if (onDisk === contents) {
      if (overlay.delete(filename)) {
        snapshot = replaceSnapshot({ fileChanges: { changed: [filename] } });
      } else {
        snapshot = ensureSnapshot();
      }
    } else if (overlay.get(filename) === contents) {
      snapshot = ensureSnapshot();
    } else {
      overlay.set(filename, contents);
      snapshot = replaceSnapshot({ fileChanges: onDisk === null ? { created: [filename] } : { changed: [filename] } });
    }
    let project = snapshot.getDefaultProjectForFile(filename);
    let sourceFile = project?.program.getSourceFile(filename);
    if (!sourceFile) {
      // Created after the snapshot was taken (a file the project's include
      // pattern matches but the compiler has not seen yet).
      snapshot = replaceSnapshot({ fileChanges: { created: [filename] } });
      project = snapshot.getDefaultProjectForFile(filename);
      sourceFile = project?.program.getSourceFile(filename);
    }
    if (!project || !sourceFile?.spanMap) return null;
    const spanMap = sourceFile.spanMap;
    const program: OpenedFile['program'] = {
      getSourceFile: (name) => project.program.getSourceFile(name) as unknown as TS.SourceFile | undefined,
      getSourceFileNames: () => project.program.getSourceFileNames(),
    };
    return {
      sourceFile: sourceFile as unknown as TS.SourceFile,
      // Same boundary as `parseFile`: the checker's node, type and symbol
      // shapes match the `typescript`-typed interfaces member for member.
      checker: project.checker as CheckerLike,
      program,
      sites: collectSites(blocks, spanMap, verbatim),
      originalRange: (node) => {
        const virtual = { start: node.getStart(), end: node.getEnd() };
        const file = node.getSourceFile() as unknown as TsgoSourceFile;
        return (file.spanMap && toOriginal(file.spanMap.segments, verbatim, virtual)) ?? virtual;
      },
    };
  }

  function dispose(): void {
    for (const snapshot of retired.splice(0)) snapshot.dispose();
    current?.dispose();
    current = null;
    parsedFiles.clear();
    api?.close();
    api = null;
  }

  return {
    kind: 'tsgo',
    tsconfigPath,
    projectRoot,
    syntax,
    parserSyntax,
    preload,
    open,
    dispose,
  };
}
