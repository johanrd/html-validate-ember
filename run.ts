#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { HtmlValidate, formatterFactory } from 'html-validate';
import type { ConfigData, Report } from 'html-validate';

import plugin from './index.js';
import { preloadGlintFiles } from './lib/glint.js';
import type { PreloadStats } from './lib/glint.js';
import { dedupeMultipassReport } from './lib/multipass-dedupe.js';

// Walk up from `start` looking for a `.htmlvalidate.json` config file
// and return its parsed contents (or null if none found / unreadable).
// We have to load the user's config ourselves rather than relying on
// html-validate's discovery: html-validate's plugin loader uses CJS
// `require()` to resolve plugins by string name, which fails silently
// for our ESM-only package. To work around that, we pass the plugin
// object directly via `plugins: [plugin]` and merge the user's rules /
// extends / transform into the same programmatic config.
//
// Limitation: parses with `JSON.parse`, so JSON5 / JSONC features
// (comments, trailing commas) aren't supported here. If you need them,
// either run html-validate's CLI directly (`npx html-validate '...'`)
// or file an issue and we'll wire in html-validate's loader.
function loadProjectConfig(start: string): ConfigData | null {
  let dir = fs.statSync(start).isDirectory() ? start : path.dirname(start);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, '.htmlvalidate.json');
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')) as ConfigData;
      } catch (err) {
        process.stderr.write(
          `[validate-gts] failed to parse ${candidate}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        return null;
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function makeValidator(userConfig: ConfigData | null): HtmlValidate {
  // Always pass the plugin object directly (bypasses CJS-require of our
  // ESM-only package). Strip any string reference to "html-validate-ember"
  // from the user's plugins array — they're a no-op via require() and
  // we provide the object-form here.
  const userPlugins = (userConfig?.plugins ?? []).filter(
    (p) => !(typeof p === 'string' && p === 'html-validate-ember'),
  );
  return new HtmlValidate({
    extends: userConfig?.extends ?? [
      'html-validate:recommended',
      'html-validate-ember:gts-recommended',
    ],
    rules: {
      'attribute-allowed-values': 'error',
      ...(userConfig?.rules ?? {}),
    },
    plugins: [plugin, ...userPlugins],
    transform: userConfig?.transform ?? {
      '^.*\\.(gts|gjs|hbs)$': 'html-validate-ember',
    },
    ...(userConfig?.elements ? { elements: userConfig.elements } : {}),
    ...(userConfig?.root ? { root: userConfig.root } : {}),
  });
}

// Recognized template file extensions:
//   .gts / .gjs — Ember template-imports (template lives inside <template>
//     blocks; JS/TS surrounds). Glint integration applies (when --glint).
//   .hbs        — classic Ember template (the file IS the template; no
//     JS portion). No Glint integration; components blank transparently
//     (open/close tags removed; children float to parent).
const TEMPLATE_EXTENSIONS = ['.gts', '.gjs', '.hbs'];

function isTemplateFile(filename: string): boolean {
  return TEMPLATE_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

function findTemplateFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTemplateFiles(full));
    } else if (isTemplateFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function expandTargets(args: string[]): string[] {
  const files: string[] = [];
  for (const arg of args) {
    const abs = path.resolve(arg);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      process.stderr.write(`[validate-gts] not found: ${arg}\n`);
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...findTemplateFiles(abs));
    } else if (isTemplateFile(abs)) {
      files.push(abs);
    } else {
      process.stderr.write(`[validate-gts] not a .gts/.gjs/.hbs file or directory: ${arg}\n`);
    }
  }
  return files;
}

function printUsage(): void {
  process.stderr.write(
    'usage: validate-gts [--glint] [--quiet] <file-or-dir>...\n' +
      '\n' +
      '  --glint    enable Glint type extraction (.gts/.gjs only; requires @glint/ember-tsc in the host project).\n' +
      '  --quiet    suppress per-file diagnostics; print only the summary.\n' +
      '\n' +
      '  Environment:\n' +
      '    HVE_GLINT=1       same as --glint (also honored when invoking html-validate directly).\n' +
      '    HVE_NO_CACHE=1    bypass the on-disk Glint extraction cache.\n' +
      '    HVE_DEBUG=1       on Glint preload, print per-file skip reasons (non-gts/gjs, read error, rewrite empty/error).\n' +
      '    HVE_MULTIPASS=1   validate every {{#if}}/{{else}} branch combination (catches errors in unselected branches; capped at 8 combinations per template).\n' +
      '\n' +
      '  Pass any mix of .gts/.gjs/.hbs files and directories. Directories are walked recursively.\n' +
      '  Exits non-zero when any file has errors.\n',
  );
}

(async () => {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  if (flags.has('--glint')) process.env['HVE_GLINT'] = '1';
  const quiet = flags.has('--quiet');
  const targetArgs = args.filter((a) => !a.startsWith('--'));

  if (targetArgs.length === 0) {
    printUsage();
    process.exit(2);
  }

  const files = expandTargets(targetArgs);
  if (files.length === 0) {
    process.stderr.write('[validate-gts] no template files matched\n');
    process.exit(2);
  }

  // Look for `.htmlvalidate.json` in the first target's ancestors. If
  // present, merge the user's rules / extends / transform into our
  // programmatic config (we can't rely on html-validate's own discovery
  // because its plugin loader uses CJS require() which doesn't work for
  // our ESM-only package).
  const userConfig = loadProjectConfig(files[0]!);
  const htmlvalidate = makeValidator(userConfig);

  // Pre-load all .gts/.gjs files into the Glint TS program in one shot,
  // so the per-file extractAttrTypeMap calls reuse a single program
  // build instead of triggering N incremental rebuilds (cold-run
  // speedup; cache hits skip the upfront rewrite). No-op when --glint
  // isn't set or @glint/ember-tsc isn't installed. `.hbs` files in the
  // target list are filtered out — Glint doesn't apply to classic
  // templates, and counting them would inflate the "analyzing N
  // templates" header with files Glint will never touch.
  const glintFiles = process.env['HVE_GLINT']
    ? files.filter((f) => f.endsWith('.gts') || f.endsWith('.gjs'))
    : [];
  if (glintFiles.length > 1) {
    const isTTY = Boolean(process.stderr.isTTY);
    process.stderr.write(`Glint: analyzing ${glintFiles.length} templates for type-aware linting…\n`);
    let lastTick = 0;
    const stats: PreloadStats = preloadGlintFiles(glintFiles, (p) => {
      const now = Date.now();
      if (isTTY) {
        // Throttle to ~10 redraws/sec; always paint terminal phases.
        if (p.phase === 'program' || p.phase === 'done' || now - lastTick > 100) {
          lastTick = now;
          if (p.phase === 'rewrite') {
            const pct = Math.floor((p.done / p.total) * 100);
            process.stderr.write(`\r  template ${p.done}/${p.total} (${pct}%)   `);
          } else if (p.phase === 'program') {
            process.stderr.write(`\r  resolving types across project…           `);
          } else if (p.phase === 'done') {
            process.stderr.write('\r' + ' '.repeat(60) + '\r'); // clear line
          }
        }
      } else {
        // Non-TTY (CI, piped output): no in-place updates. Print a few
        // checkpoints instead of a stream of lines.
        if (
          p.phase === 'rewrite' &&
          (p.done === p.total || p.done % Math.max(1, Math.floor(p.total / 4)) === 0)
        ) {
          process.stderr.write(`  template ${p.done}/${p.total}\n`);
        } else if (p.phase === 'program') {
          process.stderr.write(`  resolving types across project\n`);
        }
      }
    });
    // Categorization:
    //   - "analyzed" = file went through Glint's rewrite + TS-program
    //     pipeline (`loaded`).
    //   - "from cache" = no Glint work was needed: either a literal
    //     disk-cache hit (`cached`), or a `.gts` file with no
    //     `<template>` block (`skipped` — Glint correctly returns
    //     empty; we write a tombstone so subsequent runs are literal
    //     cache hits).
    // Both categories together always sum to the header total. The
    // per-reason skip breakdown is still available via `HVE_DEBUG=1`.
    process.stderr.write(
      `Glint: ${stats.loaded} analyzed, ${stats.cached + stats.skipped} from cache\n`,
    );
    if (stats.skipped > 0 && process.env['HVE_DEBUG']) {
      const labels: Record<keyof PreloadStats['skips'], string> = {
        nonGts: 'non-gts/gjs',
        readError: 'read error',
        rewriteError: 'rewrite error',
        rewriteEmpty: 'rewrite returned empty',
      };
      for (const [reason, entries] of Object.entries(stats.skips) as Array<
        [keyof PreloadStats['skips'], { file: string; message?: string }[]]
      >) {
        if (entries.length === 0) continue;
        process.stderr.write(`  skipped (${labels[reason]}): ${entries.length}\n`);
        for (const e of entries) {
          process.stderr.write(`    ${e.file}${e.message ? ' — ' + e.message : ''}\n`);
        }
      }
    }
  }

  const format = formatterFactory('text');
  const t0 = Date.now();
  let totalErrors = 0;
  let totalWarnings = 0;
  let valid = 0;
  let invalid = 0;
  const ruleCounts = new Map<string, number>();

  // Validation progress: only shown in --quiet TTY mode (otherwise per-file
  // diagnostics already stream to stdout and a progress line would clash).
  const validationIsTTY = Boolean(process.stderr.isTTY);
  const showValidationProgress = quiet && validationIsTTY && files.length > 5;
  let validationLastTick = 0;
  let validationDone = 0;
  const tickValidation = (): void => {
    if (!showValidationProgress) return;
    validationDone++;
    const now = Date.now();
    if (validationDone === files.length || now - validationLastTick > 100) {
      validationLastTick = now;
      const pct = Math.floor((validationDone / files.length) * 100);
      process.stderr.write(
        `\r  validating ${validationDone}/${files.length} (${pct}%)   `,
      );
    }
  };

  for (const file of files) {
    let report: Report;
    try {
      report = await htmlvalidate.validateFile(file);
    } catch (err) {
      process.stderr.write(
        `[validate-gts] fatal on ${file}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      tickValidation();
      continue;
    }
    if (report.valid) {
      valid++;
      tickValidation();
      continue;
    }
    // Multipass yields one html-validate Source per branch combination;
    // a stable error (e.g., a misnested element outside any if/else)
    // can land in multiple results. Dedupe by
    // (line, column, ruleId, message) before counting and printing.
    // No-op for templates without branch points (one source → one
    // result → set of message keys is already unique).
    const deduped = dedupeMultipassReport(report);
    if (deduped.valid) {
      // Every flagged error/warning was a multipass duplicate of one
      // already counted under a previous pass; the file is effectively
      // clean. (Shouldn't happen given the original report was invalid,
      // but guard anyway — multipass dedupe semantics.)
      valid++;
      tickValidation();
      continue;
    }
    invalid++;
    totalErrors += deduped.errorCount;
    totalWarnings += deduped.warningCount;
    for (const result of deduped.results) {
      for (const msg of result.messages) {
        ruleCounts.set(msg.ruleId, (ruleCounts.get(msg.ruleId) ?? 0) + 1);
      }
    }
    if (!quiet) {
      process.stdout.write(format(deduped.results));
    }
    tickValidation();
  }

  // Clear the validation progress line before printing the summary.
  if (showValidationProgress) {
    process.stderr.write('\r' + ' '.repeat(60) + '\r');
  }

  const elapsed = Date.now() - t0;
  process.stdout.write('\n=== summary ===\n');
  process.stdout.write(
    `elapsed: ${(elapsed / 1000).toFixed(1)}s${flags.has('--glint') ? ' (--glint)' : ''}\n`,
  );
  process.stdout.write(`files: ${files.length}\n`);
  process.stdout.write(`clean: ${valid}\n`);
  process.stdout.write(`with errors: ${invalid}\n`);
  process.stdout.write(`total errors: ${totalErrors}\n`);
  if (totalWarnings > 0) {
    process.stdout.write(`total warnings: ${totalWarnings}\n`);
  }
  if (ruleCounts.size > 0) {
    process.stdout.write('\nby rule:\n');
    const sorted = [...ruleCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [rule, count] of sorted) {
      process.stdout.write(`  ${count.toString().padStart(5)}  ${rule}\n`);
    }
  }

  if (totalErrors > 0) {
    process.exit(1);
  }
})().catch((err: unknown) => {
  process.stderr.write(
    (err instanceof Error ? err.stack ?? err.message : String(err)) + '\n',
  );
  process.exit(2);
});
