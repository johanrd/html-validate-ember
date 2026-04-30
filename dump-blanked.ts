#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Preprocessor } from 'content-tag';

import { blankTemplateContent } from './blank.js';
import { extractStringScope } from './lib/scope.js';
import { extractAttrTypeMap } from './lib/glint.js';

const args = process.argv.slice(2);
if (args.includes('--glint')) process.env['HVE_GLINT'] = '1';
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  process.stderr.write('usage: dump-blanked [--glint] <file.gts>\n');
  process.exit(2);
}

const data = fs.readFileSync(path.resolve(file), 'utf8');
const preprocessor = new Preprocessor();
const parsed = preprocessor.parse(data, { filename: file });

const scope = extractStringScope(data, path.resolve(file));

let glintTypeMap = null;
let glintComponentTagMap = null;
let glintComponentAttrMap = null;
if (process.env['HVE_GLINT']) {
  try {
    const result = extractAttrTypeMap(path.resolve(file), data);
    if (result) {
      glintTypeMap = result.attrTypeMap;
      glintComponentTagMap = result.componentTagMap;
      glintComponentAttrMap = result.componentAttrMap;
    }
  } catch (err) {
    process.stderr.write(
      `[dump-blanked] glint failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

for (const tpl of parsed) {
  if (tpl.tagName !== 'template') {
    continue;
  }
  const result = blankTemplateContent(
    tpl.contents,
    scope,
    glintTypeMap,
    glintComponentTagMap,
    glintComponentAttrMap,
  );
  if (result.error) {
    process.stderr.write(`parse error: ${result.error.message}\n`);
  }
  process.stdout.write('--- original ---\n');
  process.stdout.write(tpl.contents);
  process.stdout.write('\n--- blanked ---\n');
  process.stdout.write(result.content);
  process.stdout.write('\n--- diff (length) ---\n');
  process.stdout.write(
    `original: ${tpl.contents.length}\nblanked:  ${result.content.length}\nequal:    ${
      tpl.contents.length === result.content.length
    }\n`,
  );
}
