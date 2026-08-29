/**
 * Benchmarks with mitata. `pnpm bench` measures this checkout; with
 * `--dist <dir>` it measures another build (the base branch, from
 * `scripts/bench-compare.mjs`) against this checkout's fixtures, and
 * `--json <file>` writes the results.
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

import { bench, do_not_optimize, run } from 'mitata';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? resolve(args[i + 1]) : null;
};
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The build under test. `scripts/bench-compare.mjs` runs this script once
// per side, in separate processes: two copies in one V8 heap skew the
// numbers by 10-15 % on identical code.
const DIST = flag('--dist') ?? ROOT;
const JSON_OUT = flag('--json') ?? process.env['BENCH_JSON_OUTPUT'];

// The in-process benchmarks measure extraction, not the disk cache.
process.env['HVE_NO_CACHE'] = '1';
process.env['HVE_TS_BACKEND'] ??= 'tsgo';

const plugin = await import(resolve(DIST, 'dist/lib/glint.js'));

const fixture = (rel) => {
  const filename = resolve(ROOT, rel);
  return { filename, contents: readFileSync(filename, 'utf8') };
};
const FIXTURES = {
  'small template': fixture('examples/h32-yield-and-ambiguous-submit.gts'),
  'medium template': fixture('examples/heuristic-masks-real-bug.gts'),
  'cross-file resolution': fixture('test/glint-fixtures/curry-multi-level-consumer.gts'),
  'large template': fixture('test/bench/large.gts'),
};

// Warm up: opens the project and compiles the hot paths before anything
// is measured.
for (const { filename, contents } of Object.values(FIXTURES)) {
  for (let i = 0; i < 5; i++) do_not_optimize(plugin.extractAttrTypeMap(filename, contents));
}
globalThis.gc?.();

// A whole `dist/run.js` run. `HVE_NO_CACHE` is inherited from this process
// unless the case sets it.
function validate(cliArgs, env = {}) {
  const result = spawnSync(process.execPath, [resolve(DIST, 'dist/run.js'), ...cliArgs], {
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
const SUBSET = [
  'test/bench/large.gts',
  ...readdirSync(resolve(ROOT, 'examples'))
    .filter((f) => f.endsWith('.gts'))
    .sort()
    .slice(0, 20)
    .map((f) => `examples/${f}`),
];
// A small file: this case measures start-up, not template work.
const ONE = [SUBSET[1]];
const CACHED = { HVE_NO_CACHE: '' };
const PROCESS_CASES = {
  'cold run (cache off)': () => validate(['--glint', ...SUBSET]),
  'warm run (all cached)': () => validate(['--glint', ...SUBSET], CACHED),
  'one cached file': () => validate(['--glint', ...ONE], CACHED),
  'no glint': () => validate(['--no-glint', ...SUBSET]),
};

// Populate the disk cache for the warm cases (entries are keyed by plugin
// source, so the two sides of a comparison do not share them).
validate(['--glint', ...SUBSET], CACHED);

for (const [name, { filename, contents }] of Object.entries(FIXTURES)) {
  globalThis.gc?.();
  bench(`extract ${name}`, () => do_not_optimize(plugin.extractAttrTypeMap(filename, contents)));
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
  const samples = [];
  for (let i = 0; i < PROCESS_SAMPLES; i++) {
    const t = process.hrtime.bigint();
    runCase();
    samples.push(Number(process.hrtime.bigint() - t));
  }
  const st = stats(samples);
  console.log(`  ${name.padEnd(28)} ${ms(st.min).padStart(9)} / ${ms(st.p50).padStart(9)}`);
  processTrials.push({ alias: name, runs: [{ name, args: {}, stats: st }] });
}

if (JSON_OUT) {
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
  writeFileSync(JSON_OUT, JSON.stringify({ context: result.context, benchmarks }, null, 2));
}
