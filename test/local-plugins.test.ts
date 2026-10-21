import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, expect } from 'vitest';
import { HtmlValidate, Rule } from 'html-validate';

import plugin, { isComponentInvocation } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function noBoldSource(message: string, extra = ''): string {
  return `import { Rule } from 'html-validate';

export class NoBold extends Rule {
  setup() {
    this.on('element:ready', ({ target }) => {
      if (target.tagName === 'b') this.report(target, '${message}');${extra}
    });
  }
}
`;
}

describe('validate-gts: plugins from the project config', () => {
  // '#' and '$$' in the folder name: html-validate would read the path as a URL.
  const project = path.join(__dirname, `.tmp-local-plugin-${process.pid}#1 $$x`);
  const write = (name: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    fs.writeFileSync(path.join(project, name), text);
  };
  const run = (cwd = project): { stdout: string; stderr: string; status: number | null } => {
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'run.ts'), path.join(project, 'page.gts')], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HVE_GLINT: '0' },
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  };

  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  function setup(plugin: string): void {
    write(
      '.htmlvalidate.json',
      JSON.stringify({
        extends: ['html-validate-ember:recommended'],
        plugins: [plugin],
        rules: { 'local/no-bold': 'error' },
      }),
    );
    write('lint/rules.mjs', "import { NoBold } from './no-bold.mjs';\nexport default { name: 'local', rules: { 'local/no-bold': NoBold } };\n");
    write('page.gts', '<template><b>Bold</b></template>\n');
  }

  it('re-lints when a module the plugin imports changes', () => {
    setup('<rootDir>/lint/rules.mjs');
    write('lint/no-bold.mjs', noBoldSource('first message'));
    expect(run().stdout).toContain('first message');

    write('lint/no-bold.mjs', noBoldSource('second message'));
    expect(run().stdout).toContain('second message');
  });

  it("resolves './' plugins against the config's folder", () => {
    setup('./lint/rules.mjs');
    write('lint/no-bold.mjs', noBoldSource('relative plugin'));
    const result = run(path.dirname(project));
    expect(result.stdout).toContain('relative plugin');
    expect(result.status).toBe(1);
  });

  it('exits non-zero when a rule throws', () => {
    setup('./lint/rules.mjs');
    write('lint/no-bold.mjs', noBoldSource('unused', '\n      target.notAMethod();'));
    const result = run();
    expect(result.stderr).toContain('notAMethod is not a function');
    expect(result.stdout).toContain('failed to validate: 1');
    expect(result.status).toBe(1);
  });

  it('fails once, before validating, when a plugin cannot load', () => {
    setup('./lint/missing.mjs');
    const result = run();
    expect(result.stderr).toContain('failed to load the configuration');
    expect(result.stderr).not.toContain('fatal on');
    expect(result.status).toBe(2);
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
