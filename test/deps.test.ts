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

import { dependencyClosure, dependencySha, importSpecifiers, resolveImport } from '../lib/deps.js';
import { readCache, reportCacheKey, transformCacheKey, writeCache } from '../lib/cache.js';

const FIXTURES = fileURLToPath(new URL('./deps-fixtures', import.meta.url));

let root: string;
let tsconfig: string;
const component = (name: string) => path.join(root, 'app', 'components', name);
const read = (name: string) => fs.readFileSync(component(name), 'utf8');
const edit = (file: string, append: string) => fs.appendFileSync(file, append);
const shaOf = (name: string) => dependencySha(component(name), read(name), tsconfig);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hve-deps-'));
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

describe('resolveImport', () => {
  it('resolves relative, paths-mapped, js-to-ts and directory imports to project files', () => {
    const from = component('root.gts');
    expect(resolveImport('app/components/mid', from, tsconfig)).toBe(component('mid.gts'));
    expect(resolveImport('./leaf-two.js', from, tsconfig)).toBe(component('leaf-two.ts'));
    expect(resolveImport('./dir', from, tsconfig)).toBe(component('dir/index.ts'));
    expect(resolveImport('operations', from, tsconfig)).toBe(path.join(root, 'types', 'operations.d.ts'));
  });

  it('treats packages and unresolved specifiers as external', () => {
    const from = component('root.gts');
    expect(resolveImport('@glimmer/component', from, tsconfig)).toBeNull();
    expect(resolveImport('some-pkg', from, tsconfig)).toBeNull();
    expect(resolveImport('./missing', from, tsconfig)).toBeNull();
  });

  it('reads paths and baseUrl through a jsonc tsconfig with extends', () => {
    expect(resolveImport('app/components/leaf', component('mid.gts'), tsconfig)).toBe(component('leaf.gts'));
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

  it('is empty without a tsconfig-relative project', () => {
    expect(dependencySha(component('leaf.gts'), read('leaf.gts'), null)).toBe('no-tsconfig');
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
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hve-deps-copy-'));
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
