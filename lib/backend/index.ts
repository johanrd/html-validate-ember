// Backend selection, one per tsconfig.
//
//   HVE_TS_BACKEND=tsgo   force TypeScript 7 (fails closed when unavailable)
//   HVE_TS_BACKEND=ts6    force the TypeScript 5/6 + Glint pipeline
//   (unset)               tsgo when the tsconfig declares `contentMappers`
//                         and a TypeScript 7 package resolves, else ts6

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';

import { createTs6Backend, loadTs6Deps, ts6Syntax } from './ts6.js';
import { createTsgoBackend, loadTsgo } from './tsgo.js';
import type { TsSyntax, TypeBackend } from './types.js';

export type {
  CheckerLike,
  OpenedFile,
  PreloadProgress,
  PreloadStats,
  ProgramLike,
  SymbolLike,
  TemplateSite,
  TsSyntax,
  TypeBackend,
  TypeLike,
  VirtualRange,
} from './types.js';

const backendByTsconfig = new Map<string, TypeBackend | null>();
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`[html-validate-ember] ${message}\n`);
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function findTsconfig(start: string): string | null {
  let dir = isDirectory(start) ? start : path.dirname(start);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  return null;
}

// tsconfig.json allows comments and trailing commas, so a text match is
// used rather than JSON.parse. `extends` chains are not followed.
function declaresContentMappers(tsconfigPath: string): boolean {
  try {
    return /"contentMappers"\s*:/.test(fs.readFileSync(tsconfigPath, 'utf8'));
  } catch {
    return false;
  }
}

function selectBackend(tsconfigPath: string, filename: string): TypeBackend | null {
  const forced = process.env['HVE_TS_BACKEND'];
  const projectRoot = path.dirname(tsconfigPath);
  if (forced === 'tsgo' || (forced !== 'ts6' && declaresContentMappers(tsconfigPath))) {
    const mods = loadTsgo(projectRoot);
    if (mods) {
      return createTsgoBackend(mods, tsconfigPath);
    }
    if (forced === 'tsgo') {
      warnOnce(
        `tsgo:${tsconfigPath}`,
        `HVE_TS_BACKEND=tsgo but no TypeScript 7 package resolves from ${projectRoot} (tried typescript, @typescript/native, typescript-7; set HVE_TSGO=<package name>). Glint integration disabled.`,
      );
      return null;
    }
    warnOnce(
      `tsgo-fallback:${tsconfigPath}`,
      `${tsconfigPath} declares contentMappers but no TypeScript 7 package resolves from ${projectRoot}; using typescript 5/6 with @glint/ember-tsc instead.`,
    );
  }
  const deps = loadTs6Deps(filename);
  if (!deps) return null;
  return createTs6Backend(deps, tsconfigPath);
}

/** The backend for the project `filename` belongs to; null without a tsconfig or a usable TypeScript. */
export function backendFor(filename: string): TypeBackend | null {
  const tsconfigPath = findTsconfig(filename);
  if (!tsconfigPath) return null;
  const cached = backendByTsconfig.get(tsconfigPath);
  if (cached !== undefined) return cached;
  const backend = selectBackend(tsconfigPath, filename);
  backendByTsconfig.set(tsconfigPath, backend);
  return backend;
}

let ownSyntax: TsSyntax | null | undefined;

// The `typescript` this package itself resolves — for syntactic walks in
// projects without a tsconfig-backed backend (classic `.hbs` addons).
function ownTs6Syntax(): TsSyntax | null {
  if (ownSyntax !== undefined) return ownSyntax;
  try {
    const ts = createRequire(import.meta.url)('typescript') as typeof TS;
    ownSyntax = typeof ts.createProgram === 'function' ? ts6Syntax(ts) : null;
  } catch {
    ownSyntax = null;
  }
  return ownSyntax;
}

/** Syntax facade for parsing files reached from `filename`. */
export function syntaxFor(filename: string): TsSyntax | null {
  return backendFor(filename)?.syntax ?? ownTs6Syntax();
}

/** Dispose every backend created so far — for hosts that outlive one run. */
export function closeBackends(): void {
  for (const backend of backendByTsconfig.values()) backend?.dispose();
  backendByTsconfig.clear();
}
