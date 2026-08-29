/**
 * Benchmarks with mitata. Standalone: `pnpm bench` measures this checkout.
 * With `--control-dir <dir>` (from `scripts/bench-compare.mjs`) each
 * benchmark runs for the base branch as well, and mitata prints the pair
 * side by side.
 *
 * Two kinds of benchmark, because the costs that regressed live in
 * different places:
 *
 * - In-process: `extractAttrTypeMap` per fixture (the extraction and
 *   resolver work, with the disk cache off).
 * - Whole process: `dist/run.js` over `examples/` — cold (cache off), warm
 *   (all cached), one cached file, and `--no-glint`. These catch backend
 *   start-up and per-run costs that no single call can see.
 *
 * Both sides need `dist/` built. The harness is adapted from ember-estree.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bench, boxplot, do_not_optimize, run, summary } from 'mitata';

const args = process.argv.slice(2);
const controlIdx = args.indexOf('--control-dir');
const CONTROL_DIR = controlIdx !== -1 ? resolve(args[controlIdx + 1]) : null;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The in-process benchmarks measure extraction, not the disk cache.
process.env['HVE_NO_CACHE'] = '1';
process.env['HVE_TS_BACKEND'] ??= 'tsgo';

const experiment = await import(resolve(ROOT, 'dist/lib/glint.js'));
const control = CONTROL_DIR ? await import(resolve(CONTROL_DIR, 'dist/lib/glint.js')) : null;

const fixture = (rel) => {
  const filename = resolve(ROOT, rel);
  return { filename, contents: readFileSync(filename, 'utf8') };
};
const FIXTURES = {
  'small template': fixture('examples/h32-yield-and-ambiguous-submit.gts'),
  'medium template': fixture('examples/heuristic-masks-real-bug.gts'),
  'cross-file resolution': fixture('test/glint-fixtures/curry-multi-level-consumer.gts'),
};

// Warm both sides: opens the project and compiles the hot paths before
// anything is measured, so the first side to run pays no start-up cost.
for (const { filename, contents } of Object.values(FIXTURES)) {
  for (let i = 0; i < 5; i++) {
    do_not_optimize(experiment.extractAttrTypeMap(filename, contents));
    if (control) do_not_optimize(control.extractAttrTypeMap(filename, contents));
  }
}
globalThis.gc?.();

// A whole `dist/run.js` run. `HVE_NO_CACHE` is inherited from this process
// unless the case sets it.
function validate(dir, cliArgs, env = {}) {
  const result = spawnSync(process.execPath, [resolve(dir, 'dist/run.js'), ...cliArgs], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Exit 1 means findings (the examples have some); anything else is a crash.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`run.js exited ${result.status}:\n${result.stderr}`);
  }
}

const EXAMPLES = ['examples'];
const ONE = ['examples/heuristic-masks-real-bug.gts'];
const CACHED = { HVE_NO_CACHE: '' };
const PROCESS_CASES = {
  'cold run (cache off)': (dir) => validate(dir, ['--glint', ...EXAMPLES]),
  'warm run (all cached)': (dir) => validate(dir, ['--glint', ...EXAMPLES], CACHED),
  'one cached file': (dir) => validate(dir, ['--glint', ...ONE], CACHED),
  'no glint': (dir) => validate(dir, ['--no-glint', ...EXAMPLES]),
};

// Populate the disk cache for the warm cases, for both sides (entries are
// keyed by plugin source, so the sides do not share them).
validate(ROOT, ['--glint', ...EXAMPLES], CACHED);
if (CONTROL_DIR) validate(CONTROL_DIR, ['--glint', ...EXAMPLES], CACHED);

// Alternate which side runs first inside each pair so the small advantage
// of going first cancels out over the run.
let pairIndex = 0;
function pair(name, experimentFn, controlFn) {
  if (!controlFn) {
    bench(name, experimentFn);
    return;
  }
  const controlFirst = pairIndex++ % 2 === 0;
  boxplot(() => {
    summary(() => {
      if (controlFirst) {
        bench(`${name} (control)`, controlFn);
        bench(`${name} (experiment)`, experimentFn);
      } else {
        bench(`${name} (experiment)`, experimentFn);
        bench(`${name} (control)`, controlFn);
      }
    });
  });
}

for (const [name, { filename, contents }] of Object.entries(FIXTURES)) {
  globalThis.gc?.();
  pair(
    `extract ${name}`,
    () => do_not_optimize(experiment.extractAttrTypeMap(filename, contents)),
    control ? () => do_not_optimize(control.extractAttrTypeMap(filename, contents)) : null,
  );
}

for (const [name, runCase] of Object.entries(PROCESS_CASES)) {
  pair(
    name,
    () => runCase(ROOT),
    CONTROL_DIR ? () => runCase(CONTROL_DIR) : null,
  );
}

const result = await run({ colors: false, throw: true });

const jsonPath = process.env['BENCH_JSON_OUTPUT'];
if (jsonPath) {
  const benchmarks = result.benchmarks.map((trial) => ({
    alias: trial.alias,
    runs: trial.runs.map((r) => ({
      name: r.name,
      args: r.args,
      error: r.error ? { message: r.error.message || String(r.error) } : undefined,
      stats: r.stats
        ? {
            avg: r.stats.avg,
            min: r.stats.min,
            max: r.stats.max,
            p50: r.stats.p50,
            p75: r.stats.p75,
            p99: r.stats.p99,
            samples: r.stats.samples,
          }
        : undefined,
    })),
  }));
  writeFileSync(jsonPath, JSON.stringify({ context: result.context, benchmarks }, null, 2));
}
