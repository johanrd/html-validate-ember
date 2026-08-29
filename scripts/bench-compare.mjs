/**
 * Benchmark comparison against a base branch (adapted from ember-estree).
 *
 * Exports the base branch to a temp directory, installs and builds it, then
 * runs `test/validate.bench.mjs` once per side in its own process and
 * merges the results for the formatters.
 *
 * Usage:
 *   node scripts/bench-compare.mjs [--base <branch>]
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CACHED_CASES, ms, PROCESS_CASES, PROCESS_SAMPLES, sample, seedCache, SUBSET, trial } from '../test/bench-process.mjs';

const args = process.argv.slice(2);
const baseIdx = args.indexOf('--base');
const BASE_BRANCH = baseIdx !== -1 ? args[baseIdx + 1] : 'main';

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

// `origin/<branch>` first: in CI only the PR branch is checked out locally.
function resolveRef(branch) {
  for (const candidate of [`origin/${branch}`, branch]) {
    const result = spawnSync('git', ['rev-parse', '--verify', candidate], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status === 0) return result.stdout.trim();
  }
  throw new Error(`Could not resolve ref for branch "${branch}". Is it fetched?`);
}

const ROOT = process.cwd();
const CONTROL_DIR = join(tmpdir(), `bench-control-${BASE_BRANCH}-${Date.now()}`);

console.error(`\nSetting up control (${BASE_BRANCH}) in ${CONTROL_DIR}\n`);
const BASE_REF = resolveRef(BASE_BRANCH);
console.error(`Resolved ${BASE_BRANCH} → ${BASE_REF.slice(0, 10)}\n`);

function cleanup() {
  if (existsSync(CONTROL_DIR)) {
    try {
      rmSync(CONTROL_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

try {
  mkdirSync(CONTROL_DIR, { recursive: true });
  // Sources and manifests only; fixtures come from this checkout. Only the
  // paths that exist at the base ref, or `git archive` refuses.
  const wanted = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vitest.config.ts', 'lib', 'index.ts', 'transform.ts', 'blank.ts', 'run.ts', 'dump-blanked.ts'];
  const present = spawnSync('git', ['ls-tree', '--name-only', BASE_REF, '--', ...wanted], { encoding: 'utf8' })
    .stdout.trim()
    .split('\n')
    .filter(Boolean);
  run(`git archive ${BASE_REF} -- ${present.join(' ')} | tar -x -C "${CONTROL_DIR}"`);

  console.error(`\nInstalling and building control (${BASE_BRANCH})…\n`);
  run('pnpm install --frozen-lockfile', { cwd: CONTROL_DIR, stdio: ['inherit', 'pipe', 'inherit'] });
  // `--types node`: the base may predate tsconfig's `types`, and TypeScript 7
  // does not pick `@types/*` up on its own.
  run('pnpm exec tsc --types node', { cwd: CONTROL_DIR, stdio: ['inherit', 'pipe', 'inherit'] });

  // In-process benchmarks: one process per side, so neither copy's code
  // layout or optimisation state affects the other. Control first, then
  // experiment.
  const benchScript = join(ROOT, 'test/validate.bench.mjs');
  const hasTaskset =
    process.platform === 'linux' && spawnSync('which', ['taskset'], { stdio: 'pipe' }).status === 0;
  if (hasTaskset) console.error('CPU pinning enabled (taskset -c 0)\n');
  const sides = [
    ['control', CONTROL_DIR],
    ['experiment', ROOT],
  ];
  const results = {};
  for (const [side, dist] of sides) {
    console.error(`\nRunning benchmarks: ${side} (${dist})\n`);
    const jsonFile = join(CONTROL_DIR, `${side}.json`);
    const nodeArgs = ['--expose-gc', '--max-old-space-size=4096', benchScript, '--dist', dist, '--json', jsonFile, '--skip-process'];
    const result = spawnSync(hasTaskset ? 'taskset' : 'node', hasTaskset ? ['-c', '0', 'node', ...nodeArgs] : nodeArgs, {
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env },
    });
    if (result.status !== 0) {
      console.error(`\nBenchmark run failed (${side}).`);
      process.exit(1);
    }
    results[side] = JSON.parse(readFileSync(jsonFile, 'utf8'));
  }

  // Whole-process cases: the samples of the two builds are interleaved
  // (control, experiment, control, …) so that the runner slowing down or
  // speeding up over the minutes this takes lands on both sides alike —
  // run one side after the other and a drift shows up as a regression.
  process.env['HVE_NO_CACHE'] = '1';
  process.env['HVE_TS_BACKEND'] ??= 'tsgo';
  console.error(`\nWhole process (min / p50 of ${PROCESS_SAMPLES} interleaved runs, ${SUBSET.length} files)\n`);
  for (const [, dist] of sides) seedCache(dist);
  for (const [name, runCase] of Object.entries(PROCESS_CASES)) {
    const samples = Object.fromEntries(sides.map(([side]) => [side, []]));
    for (let i = 0; i < PROCESS_SAMPLES; i++) {
      for (const [side, dist] of sides) {
        if (CACHED_CASES.has(name)) seedCache(dist);
        samples[side].push(sample(runCase, dist));
      }
    }
    for (const [side] of sides) {
      const t = trial(name, samples[side], side);
      console.error(`  ${name.padEnd(28)} ${side.padEnd(10)} ${ms(t.runs[0].stats.min).padStart(9)} / ${ms(t.runs[0].stats.p50).padStart(9)}`);
      results[side].benchmarks.push({ alias: name, runs: t.runs.map((r) => ({ ...r, name })) });
    }
  }

  // Merge into one file with `(control)` / `(experiment)` runs, the shape
  // the formatters read.
  if (process.env.BENCH_JSON_OUTPUT) {
    const benchmarks = [];
    for (const [side, json] of Object.entries(results)) {
      for (const trial of json.benchmarks) {
        benchmarks.push({
          alias: trial.alias,
          runs: trial.runs.map((r) => ({ ...r, name: `${r.name} (${side})` })),
        });
      }
    }
    writeFileSync(process.env.BENCH_JSON_OUTPUT, JSON.stringify({ context: results.experiment.context, benchmarks }, null, 2));
  }
  console.error('\nBenchmark comparison complete.\n');
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
