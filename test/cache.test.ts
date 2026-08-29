// Disk cache: write/read roundtrip, staleness detection, and the
// path-keyed invariant (one entry per file path; edits overwrite).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  readCache,
  readReportCache,
  readTransformCache,
  reportCacheKey,
  transformCacheKey,
  writeCache,
  writeReportCache,
  writeTransformCache,
} from '../lib/cache.js';
import type { CachedTemplate, ExtractionResult } from '../lib/cache.js';

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
    writeCache(file, contents, tsconfigPath, 'ts6', makeResult());
    const got = readCache(file, contents, tsconfigPath, 'ts6');
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
    expect(readCache(file, '<template></template>', tsconfigPath, 'ts6')).toBeNull();
  });
});

describe('cache: staleness detection', () => {
  it('treats a content-SHA mismatch as a miss', () => {
    const file = path.join(templatesDir, 'changed.gts');
    fs.writeFileSync(file, 'v1');
    writeCache(file, 'v1', tsconfigPath, 'ts6', makeResult());
    // Read with different content — stored fileSha doesn't match.
    expect(readCache(file, 'v2', tsconfigPath, 'ts6')).toBeNull();
    // Original content still hits.
    expect(readCache(file, 'v1', tsconfigPath, 'ts6')).not.toBeNull();
  });

  it('treats a tsconfig-SHA mismatch as a miss', () => {
    const file = path.join(templatesDir, 'b.gts');
    fs.writeFileSync(file, 'x');
    writeCache(file, 'x', tsconfigPath, 'ts6', makeResult());
    fs.writeFileSync(tsconfigPath, '{"compilerOptions":{"target":"es5"}}');
    // The in-memory tsconfigShaCache memoizes per-process — to exercise
    // staleness we need a fresh tsconfigPath. Use a sibling.
    const altTsconfig = path.join(projectRoot, 'tsconfig.alt.json');
    fs.writeFileSync(altTsconfig, '{"compilerOptions":{"target":"es5"}}');
    expect(readCache(file, 'x', altTsconfig, 'ts6')).toBeNull();
  });

  it('treats a pluginSourceSha mismatch as a miss', () => {
    // Regression: stored entries from a previous build of the plugin
    // must not be re-used after `lib/` source changes — otherwise local
    // resolver fixes silently fail to take effect (the package version
    // doesn't bump between every dev iteration).
    const file = path.join(templatesDir, 'plugin-changed.gts');
    fs.writeFileSync(file, 'x');
    writeCache(file, 'x', tsconfigPath, 'ts6', makeResult());

    // Tamper with the stored entry's pluginSourceSha as if the plugin's
    // source had changed between writeCache and readCache. We can't
    // actually mutate this process's PLUGIN_SOURCE_SHA at runtime, so
    // we rewrite the stored file to simulate the symmetric case (the
    // process holds a NEW sha but the file on disk holds an old one).
    const sha256 = (input: string): string =>
      crypto.createHash('sha256').update(input).digest('hex');
    const entryDir = cacheDir();
    const [entryFile] = fs.readdirSync(entryDir);
    const entryPath = path.join(entryDir, entryFile!);
    const stored = JSON.parse(fs.readFileSync(entryPath, 'utf8')) as Record<string, unknown>;
    stored['pluginSourceSha'] = sha256('different-build');
    fs.writeFileSync(entryPath, JSON.stringify(stored));

    expect(readCache(file, 'x', tsconfigPath, 'ts6')).toBeNull();
  });
});

describe('cache: one entry per file path (no accumulation)', () => {
  it('overwrites the same cache file on repeat writes for one source file', () => {
    const file = path.join(templatesDir, 'edit-me.gts');
    fs.writeFileSync(file, 'v1');
    writeCache(file, 'v1', tsconfigPath, 'ts6', makeResult());
    expect(fs.readdirSync(cacheDir())).toHaveLength(1);
    // Simulate an edit: write again with new content.
    writeCache(file, 'v2', tsconfigPath, 'ts6', makeResult());
    // Still one entry (path-keyed), not two.
    expect(fs.readdirSync(cacheDir())).toHaveLength(1);
    // And it now reflects v2, not v1.
    expect(readCache(file, 'v2', tsconfigPath, 'ts6')).not.toBeNull();
    expect(readCache(file, 'v1', tsconfigPath, 'ts6')).toBeNull();
  });

  it('uses distinct entries for distinct file paths', () => {
    const a = path.join(templatesDir, 'a.gts');
    const b = path.join(templatesDir, 'b.gts');
    fs.writeFileSync(a, 'same');
    fs.writeFileSync(b, 'same');
    writeCache(a, 'same', tsconfigPath, 'ts6', makeResult());
    writeCache(b, 'same', tsconfigPath, 'ts6', makeResult());
    expect(fs.readdirSync(cacheDir())).toHaveLength(2);
  });
});

describe('transform cache', () => {
  const templates: CachedTemplate[] = [
    {
      startOffset: 10,
      endOffset: 40,
      passes: [
        {
          content: '<div>   </div>',
          error: null,
          dynamicContentOffsets: [5],
          attrInjections: [[3, [{ attr: 'type', value: 'button' }, { attr: 'hidden', value: null }]]],
          disablePerElement: [[0, ['no-inline-style']]],
        },
        { content: '<div>       </div>', error: 'unclosed', dynamicContentOffsets: [], attrInjections: [], disablePerElement: [] },
      ],
    },
  ];

  it('round-trips the passes, including the Map- and Set-shaped arrays', () => {
    const file = path.join(templatesDir, 'a.gts');
    const key = transformCacheKey(file, '<template></template>', tsconfigPath, 'ts6');
    writeTransformCache(file, key, templates);
    expect(readTransformCache(file, key)).toEqual(templates);
  });

  it('misses when the key differs', () => {
    const file = path.join(templatesDir, 'a.gts');
    writeTransformCache(file, transformCacheKey(file, 'v1', tsconfigPath, 'ts6'), templates);
    expect(readTransformCache(file, transformCacheKey(file, 'v2', tsconfigPath, 'ts6'))).toBeNull();
    expect(readTransformCache(file, transformCacheKey(file, 'v1', tsconfigPath, 'tsgo:typescript@7.0.0'))).toBeNull();
    expect(readTransformCache(file, transformCacheKey(file, 'v1', tsconfigPath, 'ts6'))).toEqual(templates);
  });
});

describe('report cache', () => {
  const report = {
    valid: false,
    errorCount: 1,
    warningCount: 0,
    results: [{ filePath: 'a.gts', messages: [{ ruleId: 'no-inline-style', severity: 2 }] }],
  };
  const key = (contents: string, config: unknown = { extends: ['html-validate:recommended'] }, version = '11.0.0', backend = 'ts6') =>
    reportCacheKey(path.join(templatesDir, 'a.gts'), contents, config, version, tsconfigPath, backend);

  it('round-trips a report', () => {
    const file = path.join(templatesDir, 'a.gts');
    writeReportCache(file, key('v1'), report);
    expect(readReportCache(file, key('v1'))).toEqual(report);
  });

  it('misses when content, config, html-validate version, backend, tsconfig or env differ', () => {
    const file = path.join(templatesDir, 'a.gts');
    writeReportCache(file, key('v1'), report);
    expect(readReportCache(file, key('v2'))).toBeNull();
    expect(readReportCache(file, key('v1', { extends: [] }))).toBeNull();
    expect(readReportCache(file, key('v1', undefined, '11.1.0'))).toBeNull();
    expect(readReportCache(file, key('v1', undefined, '11.0.0', 'tsgo:typescript@7.0.0'))).toBeNull();
    fs.writeFileSync(tsconfigPath, '{"compilerOptions":{"target":"es2020"}}');
    const otherTsconfig = path.join(projectRoot, 'tsconfig.other.json');
    fs.writeFileSync(otherTsconfig, '{}');
    expect(readReportCache(file, reportCacheKey(file, 'v1', { extends: ['html-validate:recommended'] }, '11.0.0', otherTsconfig, 'ts6'))).toBeNull();
    process.env['HVE_MAX_CONDITIONAL_BRANCHES'] = '2';
    try {
      expect(readReportCache(file, key('v1'))).toBeNull();
    } finally {
      delete process.env['HVE_MAX_CONDITIONAL_BRANCHES'];
    }
    expect(readReportCache(file, key('v1'))).toEqual(report);
  });

  it('keeps one entry per file path', () => {
    const file = path.join(templatesDir, 'a.gts');
    writeReportCache(file, key('v1'), report);
    writeReportCache(file, key('v2'), { ...report, valid: true, errorCount: 0, results: [] });
    const dir = path.join(projectRoot, 'node_modules', '.cache', 'html-validate-ember', 'report');
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect(readReportCache(file, key('v1'))).toBeNull();
    expect(readReportCache(file, key('v2'))?.valid).toBe(true);
  });
});
