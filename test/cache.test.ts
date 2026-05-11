// Disk cache: write/read roundtrip, staleness detection, and the
// path-keyed invariant (one entry per file path; edits overwrite).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { readCache, writeCache } from '../lib/cache.js';
import type { ExtractionResult } from '../lib/cache.js';

// We need a writeable parent that has a `node_modules/` so cache.ts's
// `findCacheDir` walk lands somewhere predictable. Set up a fake
// project tree under os.tmpdir().
let projectRoot: string;
let templatesDir: string;
let tsconfigPath: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hve-cache-test-'));
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  templatesDir = path.join(projectRoot, 'app', 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  fs.writeFileSync(tsconfigPath, '{"compilerOptions":{"target":"esnext"}}');
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function makeResult(): ExtractionResult {
  return {
    attrTypeMap: new Map([['1:5', { kind: 'string-literal', values: ['auto'] }]]),
    componentTagMap: new Map([['2:3', 'button']]),
    componentAttrMap: new Map([
      ['2:3', { tag: 'button', attrs: { type: 'button' }, hasSplat: false }],
    ]),
  };
}

function cacheDir(): string {
  return path.join(projectRoot, 'node_modules', '.cache', 'html-validate-ember', 'glint');
}

describe('cache: write/read roundtrip', () => {
  it('returns the same Maps that were written', () => {
    const file = path.join(templatesDir, 'a.gts');
    const contents = '<template><div /></template>';
    fs.writeFileSync(file, contents);
    writeCache(file, contents, tsconfigPath, makeResult());
    const got = readCache(file, contents, tsconfigPath);
    expect(got).not.toBeNull();
    expect(got!.attrTypeMap.get('1:5')).toEqual({ kind: 'string-literal', values: ['auto'] });
    expect(got!.componentTagMap.get('2:3')).toBe('button');
    expect(got!.componentAttrMap.get('2:3')).toMatchObject({
      tag: 'button',
      attrs: { type: 'button' },
    });
  });

  it('returns null on read miss (no entry written yet)', () => {
    const file = path.join(templatesDir, 'never-written.gts');
    fs.writeFileSync(file, '<template></template>');
    expect(readCache(file, '<template></template>', tsconfigPath)).toBeNull();
  });
});

describe('cache: staleness detection', () => {
  it('treats a content-SHA mismatch as a miss', () => {
    const file = path.join(templatesDir, 'changed.gts');
    fs.writeFileSync(file, 'v1');
    writeCache(file, 'v1', tsconfigPath, makeResult());
    // Read with different content — stored fileSha doesn't match.
    expect(readCache(file, 'v2', tsconfigPath)).toBeNull();
    // Original content still hits.
    expect(readCache(file, 'v1', tsconfigPath)).not.toBeNull();
  });

  it('treats a plugin-source-SHA mismatch as a miss (catches in-development plugin changes)', () => {
    // The cache key includes a hash of the plugin's core source files
    // so that a developer modifying lib/glint.ts (or blank.ts, etc.)
    // doesn't get stale cached results. Simulate that by writing an
    // entry directly to disk with a fabricated `pluginSourceSha`, then
    // asserting `readCache` rejects it. (We can't easily mutate the
    // module-level constant from a test, but we can write a payload
    // bypassing `writeCache`.)
    const file = path.join(templatesDir, 'src-sha-test.gts');
    const contents = '<template><div /></template>';
    fs.writeFileSync(file, contents);
    // First, write a real entry via the public API so we get a valid
    // payload structure. Then read it back to confirm it's a hit.
    writeCache(file, contents, tsconfigPath, makeResult());
    expect(readCache(file, contents, tsconfigPath)).not.toBeNull();
    // Now corrupt the entry's pluginSourceSha on disk and confirm the
    // reader rejects it.
    const dir = cacheDir();
    const entry = path.join(dir, fs.readdirSync(dir)[0]!);
    const payload = JSON.parse(fs.readFileSync(entry, 'utf8')) as {
      pluginSourceSha: string;
    };
    payload.pluginSourceSha = 'bogus-different-hash';
    fs.writeFileSync(entry, JSON.stringify(payload));
    expect(
      readCache(file, contents, tsconfigPath),
      'cache must miss when the recorded pluginSourceSha disagrees with current',
    ).toBeNull();
  });

  it('treats a tsconfig-SHA mismatch as a miss', () => {
    const file = path.join(templatesDir, 'b.gts');
    fs.writeFileSync(file, 'x');
    writeCache(file, 'x', tsconfigPath, makeResult());
    fs.writeFileSync(tsconfigPath, '{"compilerOptions":{"target":"es5"}}');
    // The in-memory tsconfigShaCache memoizes per-process — to exercise
    // staleness we need a fresh tsconfigPath. Use a sibling.
    const altTsconfig = path.join(projectRoot, 'tsconfig.alt.json');
    fs.writeFileSync(altTsconfig, '{"compilerOptions":{"target":"es5"}}');
    expect(readCache(file, 'x', altTsconfig)).toBeNull();
  });

  it('treats a pluginSourceSha mismatch as a miss', () => {
    // Regression: stored entries from a previous build of the plugin
    // must not be re-used after `lib/` source changes — otherwise local
    // resolver fixes silently fail to take effect (the package version
    // doesn't bump between every dev iteration).
    const file = path.join(templatesDir, 'plugin-changed.gts');
    fs.writeFileSync(file, 'x');
    writeCache(file, 'x', tsconfigPath, makeResult());

    // Tamper with the stored entry's pluginSourceSha as if the plugin's
    // source had changed between writeCache and readCache. We can't
    // actually mutate this process's PLUGIN_SOURCE_SHA at runtime, so
    // we rewrite the stored file to simulate the symmetric case (the
    // process holds a NEW sha but the file on disk holds an old one).
    const sha256 = (input: string): string =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:crypto').createHash('sha256').update(input).digest('hex');
    const entryDir = cacheDir();
    const [entryFile] = fs.readdirSync(entryDir);
    const entryPath = path.join(entryDir, entryFile!);
    const stored = JSON.parse(fs.readFileSync(entryPath, 'utf8')) as Record<string, unknown>;
    stored['pluginSourceSha'] = sha256('different-build');
    fs.writeFileSync(entryPath, JSON.stringify(stored));

    expect(readCache(file, 'x', tsconfigPath)).toBeNull();
  });
});

describe('cache: one entry per file path (no accumulation)', () => {
  it('overwrites the same cache file on repeat writes for one source file', () => {
    const file = path.join(templatesDir, 'edit-me.gts');
    fs.writeFileSync(file, 'v1');
    writeCache(file, 'v1', tsconfigPath, makeResult());
    expect(fs.readdirSync(cacheDir())).toHaveLength(1);
    // Simulate an edit: write again with new content.
    writeCache(file, 'v2', tsconfigPath, makeResult());
    // Still one entry (path-keyed), not two.
    expect(fs.readdirSync(cacheDir())).toHaveLength(1);
    // And it now reflects v2, not v1.
    expect(readCache(file, 'v2', tsconfigPath)).not.toBeNull();
    expect(readCache(file, 'v1', tsconfigPath)).toBeNull();
  });

  it('uses distinct entries for distinct file paths', () => {
    const a = path.join(templatesDir, 'a.gts');
    const b = path.join(templatesDir, 'b.gts');
    fs.writeFileSync(a, 'same');
    fs.writeFileSync(b, 'same');
    writeCache(a, 'same', tsconfigPath, makeResult());
    writeCache(b, 'same', tsconfigPath, makeResult());
    expect(fs.readdirSync(cacheDir())).toHaveLength(2);
  });
});
