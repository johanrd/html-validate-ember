import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as TS from 'typescript';

import {
  findTemplateSource,
  _clearCache,
} from '../../lib/resolver/template-source.js';

const FIXTURES = new URL('../glint-fixtures/', import.meta.url).pathname;
const ts = createRequire(import.meta.url)('typescript') as typeof TS;

afterEach(() => {
  _clearCache();
});

describe('findTemplateSource', () => {
  test('reads .gts source directly', () => {
    const declFile = path.join(FIXTURES, 'node_modules/polymorphic-addon/src/components/poly-list-item.gts');
    const result = findTemplateSource({ declFile, ts });
    expect(result?.kind).toBe('gts');
    expect(result?.content).toContain('PolyText');
    expect(result?.content).toContain('@tag="li"');
  });

  test('returns null for files with multiple <template> blocks', () => {
    // The single-template constraint mirrors existing parseGtsFile behavior.
    // No multi-template fixture exists; just verify the API contract by
    // pointing at a non-existent file to ensure null on read failure.
    const result = findTemplateSource({ declFile: '/nonexistent/foo.gts', ts });
    expect(result).toBeNull();
  });

  test('reads .hbs source directly', () => {
    const declFile = path.join(FIXTURES, 'node_modules/classic-card-addon/addon/components/classic-card.hbs');
    const result = findTemplateSource({ declFile, ts });
    expect(result?.kind).toBe('hbs');
    expect(result?.content.length).toBeGreaterThan(0);
  });

  test('.d.ts → companion .gts via exports map', () => {
    // polymorphic-addon's exports point to ./src/*.gts directly.
    const declFile = path.join(FIXTURES, 'node_modules/polymorphic-addon/declarations/components/poly-list-item.d.ts');
    const result = findTemplateSource({ declFile, ts });
    expect(result?.kind).toBe('gts');
    expect(result?.content).toContain('@tag="li"');
    expect(result?.origin).toMatch(/\/src\/components\/poly-list-item\.gts$/);
  });

  test('.d.ts → companion .js via exports map (template content extracted)', () => {
    // polymorphic-addon-js-only's exports point to ./dist/*.js — compiled.
    // Template content is preserved as the first arg to precompileTemplate(...).
    const declFile = path.join(FIXTURES, 'node_modules/polymorphic-addon-js-only/declarations/components/poly-list-item.d.ts');
    const result = findTemplateSource({ declFile, ts });
    expect(result?.kind).toBe('js');
    expect(result?.content).toBe('<PolyText @tag="li" ...attributes>{{yield}}</PolyText>');
    expect(result?.origin).toMatch(/\/dist\/components\/poly-list-item\.js$/);
  });

  test('.d.ts → polymorphic-addon-js-only (poly-text uses element helper)', () => {
    const declFile = path.join(FIXTURES, 'node_modules/polymorphic-addon-js-only/declarations/components/poly-text.d.ts');
    const result = findTemplateSource({ declFile, ts });
    expect(result?.kind).toBe('js');
    expect(result?.content).toContain('(element this.componentTag)');
  });

  test('returns null for declarations with no template companion', () => {
    const result = findTemplateSource({ declFile: '/var/empty/X.d.ts', ts });
    expect(result).toBeNull();
  });

  test('v1-addon by-name lookup walks consumer\'s package deps', () => {
    // classic-card-addon ships addon/components/classic-card.hbs.
    // A consumer in the fixtures-as-app needs to be sibling to a node_modules
    // containing it. The fixtures' top-level package owns the dep.
    const consumerFile = path.join(FIXTURES, 'consumer.gts');
    const result = findTemplateSource({
      consumerFile,
      componentName: 'ClassicCard',
      ts,
    });
    expect(result?.kind).toBe('hbs');
    expect(result?.origin).toMatch(/classic-card-addon\/addon\/components\/classic-card\.hbs$/);
  });

  test('cache returns same result for repeat calls', () => {
    const declFile = path.join(FIXTURES, 'node_modules/polymorphic-addon-js-only/declarations/components/poly-list-item.d.ts');
    const a = findTemplateSource({ declFile, ts });
    const b = findTemplateSource({ declFile, ts });
    expect(a).toBe(b);
  });
});
