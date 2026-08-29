/**
 * Benchmark comparison against a base branch (adapted from ember-estree).
 *
 * Exports the base branch to a temp directory, installs and builds it, then
 * runs `test/validate.bench.mjs` with `--control-dir` so mitata benchmarks
 * both sides in one process and prints them side by side.
 *
 * Usage:
 *   node scripts/bench-compare.mjs [--base <branch>]
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  console.error(`\nRunning benchmarks (experiment vs control)…\n`);
  const benchArgs = [
    '--expose-gc',
    '--max-old-space-size=4096',
    join(ROOT, 'test/validate.bench.mjs'),
    '--control-dir',
    CONTROL_DIR,
  ];

  // Pin to one CPU on Linux to reduce cross-core migration variance.
  const hasTaskset =
    process.platform === 'linux' && spawnSync('which', ['taskset'], { stdio: 'pipe' }).status === 0;
  const cmd = hasTaskset ? 'taskset' : 'node';
  const fullArgs = hasTaskset ? ['-c', '0', 'node', ...benchArgs] : benchArgs;
  if (hasTaskset) console.error('CPU pinning enabled (taskset -c 0)\n');

  const result = spawnSync(cmd, fullArgs, { stdio: 'inherit', cwd: ROOT, env: { ...process.env } });
  if (result.status !== 0) {
    console.error('\nBenchmark run failed.');
    process.exit(1);
  }
  console.error('\nBenchmark comparison complete.\n');
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
