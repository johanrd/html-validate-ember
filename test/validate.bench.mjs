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
 * - Whole process: `dist/run.js` over a fixed subset of `examples/` — cold
 *   (cache off), warm (all cached), one cached file, and `--no-glint`. These
 *   catch backend start-up and per-run costs that no single call can see;
 *   they are timed with a few samples each rather than by mitata.
 *
 * Both sides need `dist/` built. The harness is adapted from ember-estree.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// A fixed subset keeps each run short; the costs these cases guard against
// (backend start-up, uncached per-file work) show at any size.
const SUBSET = readdirSync(resolve(ROOT, 'examples'))
  .filter((f) => f.endsWith('.gts'))
  .sort()
  .slice(0, 20)
  .map((f) => `examples/${f}`);
const ONE = [SUBSET[0]];
const CACHED = { HVE_NO_CACHE: '' };
const PROCESS_CASES = {
  'cold run (cache off)': (dir) => validate(dir, ['--glint', ...SUBSET]),
  'warm run (all cached)': (dir) => validate(dir, ['--glint', ...SUBSET], CACHED),
  'one cached file': (dir) => validate(dir, ['--glint', ...ONE], CACHED),
  'no glint': (dir) => validate(dir, ['--no-glint', ...SUBSET]),
};

// Populate the disk cache for the warm cases, for both sides (entries are
// keyed by plugin source, so the sides do not share them).
validate(ROOT, ['--glint', ...SUBSET], CACHED);
if (CONTROL_DIR) validate(CONTROL_DIR, ['--glint', ...SUBSET], CACHED);

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

const result = await run({ colors: false, throw: true });

// Whole-process cases take seconds each, so they are timed here with a
// few samples (min and median) instead of mitata's twelve-sample minimum,
// and reported in the same shape as the mitata trials.
const PROCESS_SAMPLES = 3;
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  return { avg: samples.reduce((a, b) => a + b, 0) / samples.length, min: sorted[0], max: sorted.at(-1), p50, p75: p50, p99: sorted.at(-1), samples: sorted };
}
const ms = (ns) => `${(ns / 1e6).toFixed(0)} ms`;
const processTrials = [];
console.log('\nwhole process (min / p50 of %d runs, %d files)', PROCESS_SAMPLES, SUBSET.length);
for (const [name, runCase] of Object.entries(PROCESS_CASES)) {
  const sides = CONTROL_DIR
    ? [['control', CONTROL_DIR], ['experiment', ROOT]]
    : [[null, ROOT]];
  const samples = new Map(sides.map(([role]) => [role, []]));
  for (let i = 0; i < PROCESS_SAMPLES; i++) {
    // Alternate the order each round.
    for (const [role, dir] of i % 2 ? [...sides].reverse() : sides) {
      const t = process.hrtime.bigint();
      runCase(dir);
      samples.get(role).push(Number(process.hrtime.bigint() - t));
    }
  }
  const runs = [];
  for (const [role, dir] of sides) {
    const st = stats(samples.get(role));
    const label = role ? `${name} (${role})` : name;
    runs.push({ name: label, args: {}, stats: st });
    console.log(`  ${label.padEnd(36)} ${ms(st.min).padStart(9)} / ${ms(st.p50).padStart(9)}`);
  }
  processTrials.push({ alias: name, runs });
}


const jsonPath = process.env['BENCH_JSON_OUTPUT'];
if (jsonPath) {
  const benchmarks = [...result.benchmarks, ...processTrials].map((trial) => ({
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
