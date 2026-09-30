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
  it('is true for a component rendered as its root element, false for a written element', async () => {
    const seen: string[] = [];
    class Record extends Rule {
      override setup(): void {
        this.on('element:ready', ({ target }) => {
          seen.push(`${target.tagName} ${isComponentInvocation(target)}`);
        });
      }
    }

    const prevGlint = process.env['HVE_GLINT'];
    process.env['HVE_GLINT'] = '1';
    try {
      const htmlvalidate = new HtmlValidate({
        root: true,
        plugins: [plugin, { name: 'record', rules: { 'record/all': Record } }],
        rules: { 'record/all': 'error' },
        transform: { '^.*\\.(gts|gjs|hbs)$': 'html-validate-ember' },
      });
      await htmlvalidate.validateFile(path.join(root, 'examples', 'anchor-target-href-consumer.gts'));
      await htmlvalidate.validateFile(
        path.join(root, 'test', 'glint-fixtures', 'anchor-target-href-leaf.gts'),
      );
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }

    expect(seen).toEqual(['a true', 'a false']);
  });
});
