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
 * - Whole process (`test/bench-process.mjs`): `dist/run.js` over a fixed
 *   subset of `examples/`. `--skip-process` leaves them out: the comparison
 *   driver runs them itself, interleaving the two builds.
 *
 * Both sides need `dist/` built. The harness is adapted from ember-estree.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bench, do_not_optimize, run } from 'mitata';

import { ms, PROCESS_CASES, PROCESS_SAMPLES, ROOT, sample, seedCache, SUBSET, trial } from './bench-process.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? resolve(args[i + 1]) : null;
};
// The build under test. `scripts/bench-compare.mjs` runs this script once
// per side, in separate processes: two copies in one V8 heap skew the
// numbers by 10-15 % on identical code.
const DIST = flag('--dist') ?? ROOT;
const JSON_OUT = flag('--json') ?? process.env['BENCH_JSON_OUTPUT'];
const SKIP_PROCESS = args.includes('--skip-process');

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

if (!SKIP_PROCESS) seedCache(DIST);

for (const [name, { filename, contents }] of Object.entries(FIXTURES)) {
  globalThis.gc?.();
  bench(`extract ${name}`, () => do_not_optimize(plugin.extractAttrTypeMap(filename, contents)));
}

const result = await run({ colors: false, throw: true });

const processTrials = [];
if (!SKIP_PROCESS) {
  console.log('\nwhole process (min / p50 of %d runs, %d files)', PROCESS_SAMPLES, SUBSET.length);
  for (const [name, runCase] of Object.entries(PROCESS_CASES)) {
    const samples = [];
    for (let i = 0; i < PROCESS_SAMPLES; i++) samples.push(sample(runCase, DIST));
    const t = trial(name, samples);
    console.log(`  ${name.padEnd(28)} ${ms(t.runs[0].stats.min).padStart(9)} / ${ms(t.runs[0].stats.p50).padStart(9)}`);
    processTrials.push(t);
  }
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
