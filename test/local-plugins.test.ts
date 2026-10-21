import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, expect } from 'vitest';
import { HtmlValidate, Rule } from 'html-validate';

import plugin, { isComponentInvocation } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function rulesSource(message: string): string {
  return `import { Rule } from 'html-validate';

class NoBold extends Rule {
  setup() {
    this.on('element:ready', ({ target }) => {
      if (target.tagName === 'b') this.report(target, '${message}');
    });
  }
}

export default { name: 'local', rules: { 'local/no-bold': NoBold } };
`;
}

describe('validate-gts: plugins from the project config', () => {
  const project = path.join(__dirname, `.tmp-local-plugin-${process.pid}`);

  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it('loads <rootDir> plugins and re-lints when a plugin file changes', () => {
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, '.htmlvalidate.json'),
      JSON.stringify({
        extends: ['html-validate-ember:recommended'],
        plugins: ['<rootDir>/rules.mjs'],
        rules: { 'local/no-bold': 'error' },
      }),
    );
    fs.writeFileSync(path.join(project, 'page.gts'), '<template><b>Bold</b></template>\n');

    const run = (): string => {
      try {
        return execFileSync(
          path.join(root, 'node_modules', '.bin', 'tsx'),
          [path.join(root, 'run.ts'), path.join(project, 'page.gts')],
          { encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (error) {
        return String((error as { stdout?: string }).stdout ?? '');
      }
    };

    fs.writeFileSync(path.join(project, 'rules.mjs'), rulesSource('first message'));
    expect(run()).toContain('first message');

    fs.writeFileSync(path.join(project, 'rules.mjs'), rulesSource('second message'));
    expect(run()).toContain('second message');
  });
});

describe('isComponentInvocation', () => {
  async function record(glint: '0' | '1', run: (htmlvalidate: HtmlValidate) => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    class Record extends Rule {
      override setup(): void {
        this.on('element:ready', ({ target }) => {
          seen.push(`${target.tagName} ${isComponentInvocation(target)}`);
        });
      }
    }
    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = glint;
    try {
      await run(
        new HtmlValidate({
          root: true,
          plugins: [plugin, { name: 'record', rules: { 'record/all': Record } }],
          rules: { 'record/all': 'error' },
          transform: { '^.*\\.(gts|gjs|hbs)$': 'html-validate-ember' },
        }),
      );
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
    return seen;
  }

  it('is true for a component rendered as its root element, false for a written element', async () => {
    const seen = await record('1', async (htmlvalidate) => {
      await htmlvalidate.validateFile(path.join(root, 'examples', 'anchor-target-href-consumer.gts'));
      await htmlvalidate.validateFile(path.join(root, 'test', 'glint-fixtures', 'anchor-target-href-leaf.gts'));
    });
    expect(seen).toEqual(['a true', 'a false']);
  });

  it('is false for the root a component writes with (element this.tag)', async () => {
    const seen = await record('1', (htmlvalidate) =>
      htmlvalidate.validateFile(path.join(root, 'test', 'glint-fixtures', 'own-template-let-element.gts')),
    );
    expect(seen).toEqual(['div false', 'div false']);
  });

  describe('in a project', () => {
    const project = path.join(__dirname, `.tmp-invocation-${process.pid}`);
    const write = (name: string, text: string): string => {
      fs.writeFileSync(path.join(project, name), text);
      return path.join(project, name);
    };

    afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

    it('compares tags exactly, and covers built-ins, SVG children and shifted offsets', async () => {
      fs.mkdirSync(project, { recursive: true });
      write('button.gts', '<template><button type="button" ...attributes>{{yield}}</button></template>\n');
      const consumer = write(
        'consumer.gts',
        [
          "import Button from './button.gts';",
          "import { Input, Textarea } from '@ember/component';",
          '// party 🎉 time',
          '<template>',
          '  <Button>Save</Button>',
          '  <Input @value="x" />',
          '  <Textarea @value="y" />',
          '  <svg viewBox="0 0 1 1"><title>Icon</title><desc>d</desc></svg>',
          '  <b>bold</b>',
          '</template>',
          '',
        ].join('\n'),
      );
      const bom = write('bom.gts', '\uFEFF<template><b>b</b></template>\n');

      const seen = await record('0', async (htmlvalidate) => {
        await htmlvalidate.validateFile(consumer);
        await htmlvalidate.validateFile(bom);
      });
      expect(seen).toEqual([
        'button true',
        'input true',
        'textarea true',
        'svg:title false',
        'svg:desc false',
        'svg false',
        'b false',
        'b false',
      ]);
    });

    it('reads the validated text, not the file on disk', async () => {
      fs.mkdirSync(project, { recursive: true });
      write('button.gts', '<template><button type="button" ...attributes>{{yield}}</button></template>\n');
      const page = write('page.gts', "import Button from './button.gts';\n<template><b>b</b></template>\n");
      const edited = "import Button from './button.gts';\n// an unsaved line\n<template><h1>T</h1><b>b</b><Button>Go</Button></template>\n";

      const seen = await record('0', (htmlvalidate) => htmlvalidate.validateString(edited, page));
      expect(seen).toEqual(['h1 false', 'b false', 'button true']);
    });
  });
});
