/**
 * The whole-process benchmark cases: `dist/run.js` over a fixed subset of
 * `examples/` — cold (cache off), warm (all cached), one cached file, and
 * `--no-glint`. They catch backend start-up and per-run costs that no single
 * in-process call can see, and take seconds each, so they are timed with a
 * few samples (min and median) rather than by mitata.
 *
 * Shared by `test/validate.bench.mjs` (one build) and
 * `scripts/bench-compare.mjs`, which runs the samples of the two builds
 * interleaved so that runner drift lands on both sides alike.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PROCESS_SAMPLES = 3;

// A fixed subset keeps each run short; the costs these cases guard against
// (backend start-up, uncached per-file work) show at any size.
export const SUBSET = [
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

/** One `dist/run.js` run of the build at `dist`. `HVE_NO_CACHE` is inherited unless `env` sets it. */
export function validate(dist, cliArgs, env = {}) {
  const result = spawnSync(process.execPath, [resolve(dist, 'dist/run.js'), ...cliArgs], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Exit 1 means findings (the examples have some); anything else is a crash.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`run.js exited ${result.status}:\n${result.stderr}`);
  }
}

/** Populates the disk cache for the warm cases (entries are keyed by plugin source, so builds do not share them). */
export function seedCache(dist) {
  validate(dist, ['--glint', ...SUBSET], CACHED);
}

/**
 * Cases that read the disk cache. An entry is one slot per source file
 * (`lib/cache.ts` `entryPath`), whichever build wrote it last, so when two
 * builds alternate on the same fixtures each must re-seed before it samples.
 */
export const CACHED_CASES = new Set(['warm run (all cached)', 'one cached file']);

export const PROCESS_CASES = {
  'cold run (cache off)': (dist) => validate(dist, ['--glint', ...SUBSET]),
  'warm run (all cached)': (dist) => validate(dist, ['--glint', ...SUBSET], CACHED),
  'one cached file': (dist) => validate(dist, ['--glint', ...ONE], CACHED),
  'no glint': (dist) => validate(dist, ['--no-glint', ...SUBSET]),
};

/** Nanoseconds one run of `runCase` took. */
export function sample(runCase, dist) {
  const t = process.hrtime.bigint();
  runCase(dist);
  return Number(process.hrtime.bigint() - t);
}

/** Same shape as a mitata trial's stats, from a few samples. */
export function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  return { avg: samples.reduce((a, b) => a + b, 0) / samples.length, min: sorted[0], max: sorted.at(-1), p50, p75: p50, p99: sorted.at(-1), samples: sorted };
}

export const ms = (ns) => `${(ns / 1e6).toFixed(0)} ms`;

/** A trial in the mitata JSON shape, so the formatters read both kinds alike. */
export function trial(name, samples, side) {
  return { alias: name, runs: [{ name: side ? `${name} (${side})` : name, args: {}, stats: stats(samples) }] };
}
