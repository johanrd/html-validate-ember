// Dependency closure for the cache keys. The scenarios are the ones
// TypeScript's incremental build tests exercise (dependents invalidated
// when an import changes, transitively; an unrelated file untouched;
// cycles; ambient declarations reaching every file) — with one
// difference: tsc compares the exported signature, this compares content,
// so a change that tsc would ignore invalidates here too.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { dependencyClosure, dependencySha, importSpecifiers, parseJsonc, resolveProjectImport, tsconfigChainSha } from '../lib/deps.js';
import { readCache, reportCacheKey, transformCacheKey, writeCache } from '../lib/cache.js';

const FIXTURES = fileURLToPath(new URL('./deps-fixtures', import.meta.url));

let root: string;
let tsconfig: string;
const component = (name: string) => path.join(root, 'app', 'components', name);
const read = (name: string) => fs.readFileSync(component(name), 'utf8');
const edit = (file: string, append: string) => fs.appendFileSync(file, append);
const shaOf = (name: string) => dependencySha(component(name), read(name), tsconfig);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hve-deps-')));
  fs.cpSync(FIXTURES, root, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'some-pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'some-pkg', 'index.js'), 'export default 1;');
  tsconfig = path.join(root, 'tsconfig.json');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('importSpecifiers', () => {
  it('finds static, side-effect, type and dynamic imports once each', () => {
    expect(importSpecifiers(read('root.gts'))).toEqual([
      '@glimmer/component',
      'app/components/mid',
      './leaf-two.js',
      './dir',
      'operations',
      'some-pkg',
      'side-effect-only',
    ]);
    expect(importSpecifiers(read('dir/index.ts'))).toEqual(['../leaf']);
  });
});

describe('resolveProjectImport', () => {
  it('resolves relative, paths-mapped, js-to-ts and directory imports to project files', () => {
    const from = component('root.gts');
    expect(resolveProjectImport('app/components/mid', from, tsconfig)).toBe(component('mid.gts'));
    expect(resolveProjectImport('./leaf-two.js', from, tsconfig)).toBe(component('leaf-two.ts'));
    expect(resolveProjectImport('./dir', from, tsconfig)).toBe(component('dir/index.ts'));
    expect(resolveProjectImport('operations', from, tsconfig)).toBe(path.join(root, 'types', 'operations.d.ts'));
  });

  it('treats packages and unresolved specifiers as external', () => {
    const from = component('root.gts');
    expect(resolveProjectImport('@glimmer/component', from, tsconfig)).toBeNull();
    expect(resolveProjectImport('some-pkg', from, tsconfig)).toBeNull();
    expect(resolveProjectImport('./missing', from, tsconfig)).toBeNull();
  });

  it('reads paths and baseUrl through a jsonc tsconfig with extends', () => {
    expect(resolveProjectImport('app/components/leaf', component('mid.gts'), tsconfig)).toBe(component('leaf.gts'));
  });
});

describe('dependencyClosure', () => {
  it('is the transitive set of project files, without the root or packages', () => {
    expect(dependencyClosure(component('root.gts'), read('root.gts'), tsconfig)).toEqual(
      [component('dir/index.ts'), component('leaf-two.ts'), component('leaf.gts'), component('mid.gts'), path.join(root, 'types', 'operations.d.ts')].sort(),
    );
  });

  it('terminates on cycles and includes both sides', () => {
    expect(dependencyClosure(component('cycle-a.gts'), read('cycle-a.gts'), tsconfig)).toEqual([component('cycle-b.gts')]);
    expect(dependencyClosure(component('cycle-b.gts'), read('cycle-b.gts'), tsconfig)).toEqual([component('cycle-a.gts')]);
  });
});

describe('dependencySha: invalidation', () => {
  it('changes for every dependent, transitively, when a leaf changes', () => {
    const before = { root: shaOf('root.gts'), mid: shaOf('mid.gts'), leaf: shaOf('leaf.gts') };
    edit(component('leaf.gts'), '\n');
    expect(shaOf('root.gts')).not.toBe(before.root);
    expect(shaOf('mid.gts')).not.toBe(before.mid);
    // The leaf's own content is not part of its dependency sha; that is the file sha's job.
    expect(shaOf('leaf.gts')).toBe(before.leaf);
  });

  it('does not change when an unrelated file changes', () => {
    const before = shaOf('root.gts');
    edit(component('unrelated.gts'), '\n');
    expect(shaOf('root.gts')).toBe(before);
  });

  // Ambient declarations and the lockfile are hashed once per process, so
  // the change is shown with a second copy of the project.
  it('differs for every file between projects whose ambient declarations or lockfile differ', () => {
    const copy = (mutate: (dir: string) => void) => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hve-deps-copy-')));
      fs.cpSync(root, dir, { recursive: true });
      mutate(dir);
      const at = (name: string) => path.join(dir, 'app', 'components', name);
      return {
        dir,
        sha: (name: string) => dependencySha(at(name), fs.readFileSync(at(name), 'utf8'), path.join(dir, 'tsconfig.json')),
      };
    };
    const same = copy(() => {});
    const ambient = copy((dir) => edit(path.join(dir, 'types', 'global.d.ts'), '\n'));
    const lockfile = copy((dir) => edit(path.join(dir, 'pnpm-lock.yaml'), '\n'));
    try {
      for (const name of ['root.gts', 'unrelated.gts']) {
        expect(same.sha(name)).toBe(shaOf(name));
        expect(ambient.sha(name)).not.toBe(shaOf(name));
        expect(lockfile.sha(name)).not.toBe(shaOf(name));
      }
    } finally {
      for (const { dir } of [same, ambient, lockfile]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sees a dependency edited after it was first read', () => {
    const before = shaOf('mid.gts');
    // Same size, different content: mtime moves.
    const leaf = component('leaf.gts');
    fs.writeFileSync(leaf, read('leaf.gts').replace('span', 'div '));
    fs.utimesSync(leaf, new Date(), new Date(Date.now() + 5000));
    expect(shaOf('mid.gts')).not.toBe(before);
  });
});

describe('cache keys include the closure', () => {
  it('glint cache misses for the consumer after its import changes', () => {
    const file = component('mid.gts');
    const contents = read('mid.gts');
    const result = { attrTypeMap: new Map(), componentTagMap: new Map([['2:1', 'span']]), componentAttrMap: new Map() };
    writeCache(file, contents, tsconfig, 'ts6', result);
    expect(readCache(file, contents, tsconfig, 'ts6')).not.toBeNull();
    edit(component('leaf.gts'), '\n');
    expect(readCache(file, contents, tsconfig, 'ts6')).toBeNull();
  });

  it('transform and report keys change when an import changes and not when an unrelated file does', () => {
    const file = component('mid.gts');
    const contents = read('mid.gts');
    const keys = () => [transformCacheKey(file, contents, tsconfig, 'ts6'), reportCacheKey(file, contents, {}, '11.0.0', tsconfig, 'ts6')];
    const before = keys();
    edit(component('unrelated.gts'), '\n');
    expect(keys()).toEqual(before);
    edit(component('leaf.gts'), '\n');
    expect(keys()[0]).not.toBe(before[0]);
    expect(keys()[1]).not.toBe(before[1]);
  });
});

describe('tsconfig reading', () => {
  it('parses strings that end in a backslash and keeps comments and commas inside strings', () => {
    expect(parseJsonc('{ "outDir": "c:\\\\out\\\\", // c\n "url": "http://x/*", /* b */ "glob": "src/{a,}", "n": [1, 2,], }')).toEqual({
      outDir: 'c:\\out\\',
      url: 'http://x/*',
      glob: 'src/{a,}',
      n: [1, 2],
    });
  });

  it('keeps resolving when a tsconfig has a malformed paths entry or cannot be parsed', () => {
    fs.writeFileSync(tsconfig, '{ "compilerOptions": { "baseUrl": ".", "paths": { "app/*": "./app/*", "*": ["./types/*"] } } }');
    const from = component('root.gts');
    expect(() => shaOf('root.gts')).not.toThrow();
    expect(resolveProjectImport('operations', from, tsconfig)).toBe(path.join(root, 'types', 'operations.d.ts'));
    expect(resolveProjectImport('app/components/mid', from, tsconfig)).toBe(component('mid.gts'));
    fs.writeFileSync(tsconfig, '{ not json');
    expect(() => shaOf('root.gts')).not.toThrow();
  });

  it('prefers the pattern with the longest prefix, like tsc', () => {
    fs.mkdirSync(path.join(root, 'types', 'app', 'components'), { recursive: true });
    fs.writeFileSync(path.join(root, 'types', 'app', 'components', 'mid.d.ts'), 'export {}');
    fs.writeFileSync(tsconfig, '{ "compilerOptions": { "paths": { "*": ["./types/*"], "app/*": ["./app/*"] } } }');
    expect(resolveProjectImport('app/components/mid', component('root.gts'), tsconfig)).toBe(component('mid.gts'));
  });

  it('resolves paths against the inherited baseUrl and lets a later extends entry win', () => {
    fs.mkdirSync(path.join(root, 'src', 'lib', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'lib', 'x', 'a.ts'), 'export {}');
    fs.writeFileSync(path.join(root, 'tsconfig.a.json'), '{ "compilerOptions": { "baseUrl": "./app" } }');
    fs.writeFileSync(path.join(root, 'tsconfig.b.json'), '{ "compilerOptions": { "baseUrl": "./src" } }');
    fs.writeFileSync(tsconfig, '{ "extends": ["./tsconfig.a.json", "./tsconfig.b.json"], "compilerOptions": { "paths": { "x/*": ["./lib/x/*"] } } }');
    expect(resolveProjectImport('x/a', component('root.gts'), tsconfig)).toBe(path.join(root, 'src', 'lib', 'x', 'a.ts'));
  });

  it('follows a package extends through its tsconfig field', () => {
    const pkg = path.join(root, 'node_modules', '@acme', 'tsconfig');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{ "name": "@acme/tsconfig", "tsconfig": "base.json" }');
    fs.writeFileSync(path.join(pkg, 'base.json'), '{ "compilerOptions": { "paths": { "app/*": ["./app/*"] } } }');
    fs.writeFileSync(tsconfig, '{ "extends": "@acme/tsconfig" }');
    // paths declared in node_modules resolve against that config's directory, like tsc
    expect(resolveProjectImport('app/components/mid', component('root.gts'), tsconfig)).toBeNull();
    fs.writeFileSync(path.join(pkg, 'base.json'), '{ "compilerOptions": { "baseUrl": "../../.." , "paths": { "app/*": ["./app/*"] } } }');
    expect(resolveProjectImport('app/components/mid', component('root.gts'), tsconfig)).toBe(component('mid.gts'));
  });

  it('sees an edit to tsconfig paths', () => {
    const before = shaOf('root.gts');
    fs.writeFileSync(tsconfig, '{ "compilerOptions": { "paths": { "*": ["./types/*"] } } }');
    expect(shaOf('root.gts')).not.toBe(before);
  });
});

describe('workspace sources', () => {
  it('tracks files outside the tsconfig directory reached through paths', () => {
    const shared = path.join(path.dirname(root), path.basename(root) + '-shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'button.gts'), '<template><button /></template>');
    fs.writeFileSync(tsconfig, `{ "compilerOptions": { "paths": { "@acme/ui/*": ["../${path.basename(shared)}/*"] } } }`);
    fs.writeFileSync(component('root.gts'), "import Button from '@acme/ui/button';\n<template><Button /></template>");
    try {
      const before = shaOf('root.gts');
      expect(dependencyClosure(component('root.gts'), read('root.gts'), tsconfig)).toEqual([path.join(shared, 'button.gts')]);
      edit(path.join(shared, 'button.gts'), '\n');
      expect(shaOf('root.gts')).not.toBe(before);
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });

  it('tracks a workspace package linked into node_modules by its real path', () => {
    const pkgSource = path.join(root, 'packages', 'ui');
    fs.mkdirSync(pkgSource, { recursive: true });
    fs.writeFileSync(path.join(pkgSource, 'button.gts'), '<template><button /></template>');
    fs.mkdirSync(path.join(root, 'node_modules', '@acme'), { recursive: true });
    fs.symlinkSync(pkgSource, path.join(root, 'node_modules', '@acme', 'ui'));
    fs.writeFileSync(tsconfig, '{ "compilerOptions": { "baseUrl": "./node_modules" } }');
    fs.writeFileSync(component('root.gts'), "import Button from '@acme/ui/button';\n<template><Button /></template>");
    expect(dependencyClosure(component('root.gts'), read('root.gts'), tsconfig)).toEqual([path.join(pkgSource, 'button.gts')]);
    expect(resolveProjectImport('some-pkg', component('root.gts'), tsconfig)).toBeNull();
  });
});

describe('long-lived process', () => {
  it('sees a dependency created after the import was first unresolved', () => {
    fs.writeFileSync(component('root.gts'), "import Card from './card';\n<template><Card /></template>");
    expect(dependencyClosure(component('root.gts'), read('root.gts'), tsconfig)).toEqual([]);
    fs.writeFileSync(component('card.gts'), '<template><article /></template>');
    fs.utimesSync(path.dirname(component('card.gts')), new Date(), new Date(Date.now() + 5000));
    expect(dependencyClosure(component('root.gts'), read('root.gts'), tsconfig)).toEqual([component('card.gts')]);
  });

  it('reaches .hbs templates, and only those, through a registry file that imports components', () => {
    fs.writeFileSync(
      path.join(root, 'types', 'registry.d.ts'),
      "import Leaf from '../app/components/leaf';\ndeclare module '@glint/environment-ember-loose/registry' { export default interface Registry { Leaf: typeof Leaf } }\n",
    );
    fs.mkdirSync(path.join(root, 'app', 'templates'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'templates', 'page.hbs'), '<Leaf @label="x" />');
    const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hve-deps-copy-')));
    fs.cpSync(root, copy, { recursive: true });
    edit(path.join(copy, 'app', 'components', 'leaf.gts'), '\n');
    const sha = (dir: string, rel: string) => {
      const at = path.join(dir, rel);
      return dependencySha(at, fs.readFileSync(at, 'utf8'), path.join(dir, 'tsconfig.json'));
    };
    try {
      expect(sha(copy, 'app/templates/page.hbs')).not.toBe(sha(root, 'app/templates/page.hbs'));
      // a .gts that does not import leaf.gts is not affected
      expect(sha(copy, 'app/components/unrelated.gts')).toBe(sha(root, 'app/components/unrelated.gts'));
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it('counts a source file with a module augmentation as a project-wide input', () => {
    const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hve-deps-copy-')));
    fs.cpSync(root, copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'app', 'components', 'registry.ts'), "declare module '@ember/service' { interface Registry { x: 1 } }\n");
    try {
      const at = path.join(copy, 'app', 'components', 'unrelated.gts');
      expect(dependencySha(at, fs.readFileSync(at, 'utf8'), path.join(copy, 'tsconfig.json'))).not.toBe(shaOf('unrelated.gts'));
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe('without Glint', () => {
  it('keeps the closure in the transform and report keys: the resolver still reads imported templates', () => {
    const file = component('mid.gts');
    const contents = read('mid.gts');
    process.env['HVE_GLINT'] = '0';
    try {
      const before = [transformCacheKey(file, contents, tsconfig, 'ts6'), reportCacheKey(file, contents, {}, '11.0.0', tsconfig, 'ts6')];
      edit(component('leaf.gts'), '\n');
      const after = [transformCacheKey(file, contents, tsconfig, 'ts6'), reportCacheKey(file, contents, {}, '11.0.0', tsconfig, 'ts6')];
      expect(after[0]).not.toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
    } finally {
      delete process.env['HVE_GLINT'];
    }
  });
});

describe('files the resolver reads without an import', () => {
  it('includes a module\'s co-located .hbs template and templates/components peer', () => {
    fs.writeFileSync(component('classic.ts'), 'export default class {}');
    fs.writeFileSync(component('classic.hbs'), '<li>{{yield}}</li>');
    fs.mkdirSync(path.join(root, 'app', 'templates', 'components'), { recursive: true });
    fs.writeFileSync(component('peer.ts'), 'export default class {}');
    fs.writeFileSync(path.join(root, 'app', 'templates', 'components', 'peer.hbs'), '<li>{{yield}}</li>');
    fs.writeFileSync(component('root.gts'), "import Classic from './classic';\nimport Peer from './peer';\n<template><Classic /><Peer /></template>");
    expect(dependencyClosure(component('root.gts'), read('root.gts'), tsconfig)).toEqual(
      [component('classic.hbs'), component('classic.ts'), component('peer.ts'), path.join(root, 'app', 'templates', 'components', 'peer.hbs')].sort(),
    );
    const before = shaOf('root.gts');
    edit(component('classic.hbs'), '\n');
    expect(shaOf('root.gts')).not.toBe(before);
  });

  it('follows /// <reference path> directives', () => {
    fs.writeFileSync(component('root.gts'), '/// <reference path="../../types/global.d.ts" />\n<template></template>');
    expect(importSpecifiers(read('root.gts'))).toEqual(['../../types/global.d.ts']);
    expect(dependencyClosure(component('root.gts'), read('root.gts'), tsconfig)).toEqual([path.join(root, 'types', 'global.d.ts')]);
  });
});

describe('project layout', () => {
  it('finds the lockfile above the tsconfig directory (workspace root)', () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hve-deps-ws-')));
    const app = path.join(workspace, 'packages', 'app');
    fs.cpSync(root, app, { recursive: true });
    fs.rmSync(path.join(app, 'pnpm-lock.yaml'));
    fs.writeFileSync(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    const sha = () => dependencySha(path.join(app, 'app/components/unrelated.gts'), '', path.join(app, 'tsconfig.json'));
    try {
      const before = sha();
      edit(path.join(workspace, 'pnpm-lock.yaml'), '\n');
      expect(sha()).not.toBe(before);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('does not walk a nested package for project-wide inputs', () => {
    const before = shaOf('unrelated.gts');
    fs.mkdirSync(path.join(root, 'packages', 'other'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'other', 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'packages', 'other', 'global.d.ts'), 'declare const other: 1;');
    expect(shaOf('unrelated.gts')).toBe(before);
    fs.writeFileSync(path.join(root, 'types', 'more.d.ts'), 'declare const more: 1;');
    expect(shaOf('unrelated.gts')).not.toBe(before);
  });

  it('resolves relative imports without a tsconfig, and nothing else', () => {
    fs.rmSync(tsconfig);
    fs.rmSync(path.join(root, 'tsconfig.base.json'));
    expect(dependencyClosure(component('mid.gts'), read('mid.gts'), null)).toEqual([component('leaf.gts')]);
    expect(resolveProjectImport('app/components/mid', component('root.gts'), null)).toBeNull();
    const before = dependencySha(component('mid.gts'), read('mid.gts'), null);
    edit(component('leaf.gts'), '\n');
    expect(dependencySha(component('mid.gts'), read('mid.gts'), null)).not.toBe(before);
  });

  it('hashes the whole extends chain into the tsconfig sha', () => {
    const before = tsconfigChainSha(tsconfig);
    edit(path.join(root, 'tsconfig.base.json'), '\n');
    expect(tsconfigChainSha(tsconfig)).not.toBe(before);
  });
});
