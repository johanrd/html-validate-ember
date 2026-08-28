// Ecosystem CI runner.
//
// Reads `ecosystem/targets.json`, clones each target at its pinned SHA into
// `ecosystem/.cache/<name>/`, runs the plugin against the configured globs,
// and either compares the resulting findings to `ecosystem/baselines/<name>.json`
// (default: `--check`) or overwrites the baseline (`--update`). The script is
// deliberately minimal — single file, no extra deps beyond what the package
// already has.
//
// Usage:
//   tsx ecosystem/run.ts                 # check all targets, exit 1 on diff
//   tsx ecosystem/run.ts --update        # write/refresh baselines
//   tsx ecosystem/run.ts --target=foo    # restrict to one or more targets (comma-separated)
//   tsx ecosystem/run.ts --no-clone      # skip clone/fetch (uses .cache as-is, faster local iteration)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { HtmlValidate } from 'html-validate';
import type { Report, RuleConfig } from 'html-validate';

import plugin from '../index.js';
import { dedupeMultipassReport } from '../lib/multipass-dedupe.js';

interface Target {
  name: string;
  repo: string;
  ref: string;
  include: string[];
  exclude?: string[];
  rules?: RuleConfig;
  // Run validation with HVE_GLINT=1 enabled. Requires installing the target's
  // dependencies (Glint resolves `@glint/ember-tsc` from the *target's*
  // node_modules — see lib/glint.ts:loadDeps). Default true; set to false for
  // targets where we don't want to pay the install cost or where install
  // doesn't work cleanly. On install failure the runner falls back to no-Glint
  // and prints a warning rather than failing the target.
  glint?: boolean;
  // Optional build command(s) run after a fresh install, before validation.
  // Needed for targets whose workspace packages must be built so the plugin
  // can resolve cross-package component templates: an unbuilt source-only
  // workspace dep (e.g. HDS's `@hashicorp/design-system-components`, whose
  // `files` allowlist ships only `dist`/`declarations` — absent until the
  // package's `rollup` build runs) resolves to nothing, so PascalCase
  // components blank transparently and structural rules (prefer-tbody,
  // no-implicit-close, unique-landmark, …) can't see the rendered DOM.
  // Each entry is an argv array run from the repo root. After building, the
  // runner re-installs to re-inject the freshly-built workspace packages
  // into pnpm's virtual store (workspace deps are injected by content, not
  // symlinked, so the store copy is stale until reinstall).
  build?: string[][];
}

interface Finding {
  file: string;
  line: number;
  column: number;
  // html-validate uses numeric severity internally (1=warn, 2=error).
  // Baselines store the human-readable form so consumers don't have to
  // remember the mapping. "error" findings fail builds; "warning"
  // findings are advisory and surface in lint output without blocking.
  // Both are recorded so a regression that adds a warning to a
  // previously-warning-free file still shows in the next CI diff.
  severity: 'error' | 'warning';
  ruleId: string;
  message: string;
}

interface Baseline {
  // Pinned at the time the baseline was generated. If targets.json moves to a
  // newer SHA but the baseline still records the old one, the runner refuses to
  // diff (would be apples-to-oranges) and asks the operator to re-baseline.
  ref: string;
  fileCount: number;
  findings: Finding[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');
const BASELINE_DIR = path.join(__dirname, 'baselines');
const TARGETS_FILE = path.join(__dirname, 'targets.json');

interface ParsedArgs {
  update: boolean;
  noClone: boolean;
  // Force Glint OFF for every target while still installing + building
  // deps (so the canonical resolver has built packages to read). Used to
  // measure Glint's contribution vs the no-Glint canonical resolver.
  noGlint: boolean;
  targetFilter: Set<string> | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let update = false;
  let noClone = false;
  let noGlint = false;
  let targetFilter: Set<string> | null = null;
  for (const a of argv) {
    if (a === '--update') update = true;
    else if (a === '--no-clone') noClone = true;
    else if (a === '--no-glint') noGlint = true;
    else if (a.startsWith('--target=')) {
      const val = a.slice('--target='.length);
      if (val) targetFilter = new Set(val.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a === '--check') {
      // default; accepted for clarity
    } else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return { update, noClone, noGlint, targetFilter };
}

function loadTargets(): Target[] {
  const raw = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8')) as { targets: Target[] };
  return raw.targets;
}

// Clone a target into `.cache/<name>` at its pinned SHA. Existing clones are
// reused — we just `fetch` and `checkout` to the pinned ref. `--filter=blob:none`
// defers blob downloads until checkout, which makes initial clones ~5-10× faster
// on large repos like hashicorp/design-system without giving up the ability to
// check out arbitrary SHAs.
function ensureClone(target: Target, noClone: boolean): string {
  const dir = path.join(CACHE_DIR, target.name);
  const url = `https://github.com/${target.repo}.git`;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!fs.existsSync(dir)) {
    if (noClone) {
      throw new Error(`--no-clone but ${dir} does not exist; remove --no-clone for first run`);
    }
    process.stderr.write(`[ecosystem] cloning ${target.repo} → ${dir}\n`);
    execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', url, dir], {
      stdio: 'inherit',
    });
  }
  if (!noClone) {
    // Make sure we can resolve the pinned SHA — fetch by SHA on top of the
    // existing clone. GitHub allows on-demand fetch of any reachable SHA.
    execFileSync('git', ['-C', dir, 'fetch', '--filter=blob:none', 'origin', target.ref], {
      stdio: 'inherit',
    });
  }
  execFileSync('git', ['-C', dir, '-c', 'advice.detachedHead=false', 'checkout', target.ref], {
    stdio: 'inherit',
  });
  return dir;
}

// Best-effort install of a target's deps so the validator can resolve
// `@glint/ember-tsc` from the target's own node_modules (Glint integration is
// type-aware and uses the target's TS program — there's no way around having
// its deps installed). Detects the package manager from the lockfile, runs
// install with a wall-clock timeout, and returns true on success. Failure is
// non-fatal: the caller falls back to no-Glint validation and the run
// continues. `--ignore-scripts` is intentional — we're running cloned third-
// party code and don't want their lifecycle scripts executing.
function installDeps(repoDir: string, target: Target): boolean {
  let cmd: string;
  let args: string[];
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) {
    cmd = 'pnpm';
    args = ['install', '--frozen-lockfile', '--ignore-scripts'];
  } else if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) {
    // Works for yarn classic; yarn berry rejects `--frozen-lockfile` and
    // wants `--immutable`. We don't retry — install failure is non-fatal
    // and the caller logs it then continues without Glint.
    cmd = 'yarn';
    args = ['install', '--frozen-lockfile', '--ignore-scripts'];
  } else if (fs.existsSync(path.join(repoDir, 'package-lock.json'))) {
    cmd = 'npm';
    args = ['ci', '--ignore-scripts'];
  } else {
    process.stderr.write(`  [glint] no lockfile found in ${target.name}; skipping install\n`);
    return false;
  }
  process.stderr.write(`  [glint] ${cmd} ${args.join(' ')} (in ${target.name})\n`);
  try {
    execFileSync(cmd, args, {
      cwd: repoDir,
      stdio: 'inherit',
      timeout: 5 * 60 * 1000,
    });
    return true;
  } catch (err) {
    process.stderr.write(
      `  [glint] install failed for ${target.name}: ${
        err instanceof Error ? err.message : String(err)
      }\n  [glint] falling back to no-Glint validation for this target\n`,
    );
    return false;
  }
}

// Build a target's workspace packages so the plugin can resolve
// cross-package component templates. Runs each configured `build` argv
// from the repo root with a wall-clock timeout. Build failure is
// non-fatal: we warn and continue (the affected components just blank
// transparently, as they did before — same as a missing dep). Like
// `installDeps`, this runs cloned third-party build scripts, so it's
// gated on an explicit per-target `build` config rather than run for
// every target.
function runBuild(repoDir: string, target: Target): boolean {
  if (!target.build || target.build.length === 0) return true;
  for (const argv of target.build) {
    const [cmd, ...rest] = argv;
    if (!cmd) continue;
    process.stderr.write(`  [build] ${argv.join(' ')} (in ${target.name})\n`);
    try {
      execFileSync(cmd, rest, {
        cwd: repoDir,
        stdio: 'inherit',
        timeout: 10 * 60 * 1000,
      });
    } catch (err) {
      process.stderr.write(
        `  [build] build failed for ${target.name}: ${
          err instanceof Error ? err.message : String(err)
        }\n  [build] continuing — affected components blank transparently\n`,
      );
      return false;
    }
  }
  return true;
}

// Convert a minimatch-ish glob to a RegExp. We intentionally support a small
// subset (`**`, `*`, `?`, `{a,b}`) rather than pulling in a dep — these globs
// are author-curated in targets.json, not user input, and the patterns we need
// are simple.
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` matches zero or more path segments; standalone `**` matches anything.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i++;
      } else {
        const inner = glob.slice(i + 1, end).split(',').map((s) => s.trim());
        re += '(?:' + inner.map((s) => s.replace(/[.+^$|()[\]\\]/g, '\\$&')).join('|') + ')';
        i = end + 1;
      }
    } else if ('.+^$|()[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

function listFiles(repoDir: string, target: Target): string[] {
  const includeRes = target.include.map(globToRegExp);
  const excludeRes = (target.exclude ?? []).map(globToRegExp);
  const out: string[] = [];
  function walk(dir: string): void {
    const rel = path.relative(repoDir, dir);
    if (rel.split(path.sep).some((seg) => seg === 'node_modules' || seg === '.git' || seg === 'dist' || seg === 'tmp')) {
      return;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relFull = path.relative(repoDir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (excludeRes.some((re) => re.test(relFull))) continue;
        if (includeRes.some((re) => re.test(relFull))) out.push(relFull);
      }
    }
  }
  walk(repoDir);
  out.sort();
  return out;
}

// Stylistic rules from `html-validate:recommended` that fire constantly on
// legitimate Ember/Glimmer code without flagging a real bug. We suppress them
// for the ecosystem run so the regression signal we actually care about
// (content-model, a11y, required-attribute changes) isn't drowned in style
// noise across a dozen large real-world repos.
//
// Deliberately applied HERE, in the ecosystem config — NOT in the plugin's
// shipped `:recommended` / `:gts-recommended` presets, which stay unchanged for
// real users. The sheer volume these rules generate across the targets is
// itself an argument that the plugin's recommended set might want the same
// treatment; that question is tracked in PR #47
// (https://github.com/johanrd/html-validate-ember/pull/47), not decided here.
//   - no-inline-style: bans `style=`, breaks runtime style-binding
//     (`<div style={{this.computedStyle}}>`)
//   - void-style: omit-vs-selfclosing is a harmless house-style choice
//   - prefer-native-element: real a11y signal, but design systems wrap generic
//     elements on purpose — demoted to warn, not silenced
const ECOSYSTEM_RULE_OVERRIDES: RuleConfig = {
  'no-inline-style': 'off',
  'void-style': 'off',
  'prefer-native-element': 'warn',
};

// Config the ecosystem run validates against. We extend the plugin's shipped
// `:gts-recommended` preset (so we exercise the real preset users get) and then
// layer ECOSYSTEM_RULE_OVERRIDES on top; `attribute-allowed-values: 'error'`
// matches the bundled `validate-gts` CLI's promotion. We intentionally do NOT
// honor the target repo's `.htmlvalidate.json`: ecosystem CI exists to catch
// *plugin*-side regressions, and a stable fixed config keeps the signal
// apples-to-apples across PRs (otherwise a target-side rule-toggle would
// silently change baseline output). Per-target `rules` still win (spread last).
//
// Glint is enabled per-target (default on, opt-out via `glint: false`
// in targets.json). `main()` installs the target's deps before running
// — needed because Glint resolves `@glint/ember-tsc` from the *target's*
// node_modules. Install failures fall back to no-Glint validation.
function makeValidator(target: Target): HtmlValidate {
  return new HtmlValidate({
    root: true,
    extends: ['html-validate:recommended', 'html-validate-ember:gts-recommended'],
    rules: {
      'attribute-allowed-values': 'error',
      ...ECOSYSTEM_RULE_OVERRIDES,
      ...(target.rules ?? {}),
    },
    plugins: [plugin],
    transform: { '^.*\\.(gts|gjs|hbs)$': 'html-validate-ember' },
  });
}

async function validateTarget(target: Target, repoDir: string): Promise<{ files: number; findings: Finding[] }> {
  const files = listFiles(repoDir, target);
  const validator = makeValidator(target);
  const findings: Finding[] = [];
  for (const rel of files) {
    const abs = path.join(repoDir, rel);
    let report: Report;
    try {
      report = await validator.validateFile(abs);
    } catch (err) {
      // Non-zero exit on parser/transformer crashes — these are bugs in the
      // plugin, not findings against user code, and they shouldn't silently
      // disappear into a baseline.
      process.stderr.write(
        `[ecosystem] ${target.name}: fatal on ${rel}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      findings.push({
        file: rel,
        line: 1,
        column: 1,
        severity: 'error',
        ruleId: '__transformer-crash__',
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // Don't skip on `report.valid === true`: a valid report has no
    // ERRORS, but it can still carry warnings (e.g. a file whose only
    // diagnostic is a `prefer-native-element` warning). We want those
    // in the baseline too — otherwise the warning silently appears /
    // disappears as the file gains/loses errors.
    const deduped = dedupeMultipassReport(report);
    for (const result of deduped.results) {
      for (const m of result.messages) {
        // html-validate's Severity: 1 = warn, 2 = error. Anything
        // else is unexpected; default to "error" so it doesn't silently
        // collapse to advisory.
        const severity: 'error' | 'warning' = m.severity === 1 ? 'warning' : 'error';
        findings.push({
          file: rel,
          line: m.line,
          column: m.column,
          severity,
          ruleId: m.ruleId,
          message: m.message,
        });
      }
    }
  }
  findings.sort((a, b) => {
    return (
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.severity.localeCompare(b.severity) ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.message.localeCompare(b.message)
    );
  });
  return { files: files.length, findings };
}

function findingKey(f: Finding): string {
  return `${f.file}:${f.line}:${f.column}:${f.severity}:${f.ruleId}:${f.message}`;
}

function diffFindings(baseline: Finding[], current: Finding[]): { added: Finding[]; removed: Finding[] } {
  const baseKeys = new Set(baseline.map(findingKey));
  const curKeys = new Set(current.map(findingKey));
  const added = current.filter((f) => !baseKeys.has(findingKey(f)));
  const removed = baseline.filter((f) => !curKeys.has(findingKey(f)));
  return { added, removed };
}

function loadBaseline(name: string): Baseline | null {
  const file = path.join(BASELINE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
}

function writeBaseline(name: string, baseline: Baseline): void {
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  const file = path.join(BASELINE_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n');
}

function summarizeFindings(findings: Finding[], limit = 20): string {
  if (findings.length === 0) return '  (none)\n';
  const effectiveLimit = process.env['HVE_FULL_DIFF'] === '1' ? findings.length : limit;
  const out: string[] = [];
  for (const f of findings.slice(0, effectiveLimit)) {
    out.push(`  ${f.file}:${f.line}:${f.column}  [${f.severity}] ${f.ruleId}\n    ${f.message}\n`);
  }
  if (findings.length > effectiveLimit) {
    out.push(`  … and ${findings.length - effectiveLimit} more\n`);
  }
  return out.join('');
}

function countBySeverity(findings: Finding[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allTargets = loadTargets();
  const targets = args.targetFilter
    ? allTargets.filter((t) => args.targetFilter!.has(t.name))
    : allTargets;
  if (args.targetFilter && targets.length === 0) {
    process.stderr.write(`no targets matched --target=${[...args.targetFilter].join(',')}\n`);
    process.exit(2);
  }

  let regressions = 0;
  let crashedTargets = 0;
  for (const target of targets) {
    process.stderr.write(`\n=== ${target.name} (${target.repo} @ ${target.ref.slice(0, 12)}) ===\n`);
    const repoDir = ensureClone(target, args.noClone);
    const wantGlint = target.glint !== false;
    const haveDeps = wantGlint && fs.existsSync(path.join(repoDir, 'node_modules'));
    let didInstall = false;
    let installed = haveDeps;
    if (wantGlint && !haveDeps && !args.noClone) {
      installed = installDeps(repoDir, target);
      didInstall = installed;
    }
    // Build workspace packages so cross-package component templates
    // resolve. Only after a *fresh* install (didInstall) — on a warm
    // `.cache` the build artifacts already persist, and the Glint disk
    // cache, populated from the post-build state, stays consistent. The
    // build runs before any validation, so the freshly-built output is
    // what extraction sees (no stale-cache window). Re-inject afterward
    // so pnpm copies the built `dist`/`declarations` into the store.
    if (didInstall && runBuild(repoDir, target)) {
      installDeps(repoDir, target);
    }
    // `wantGlint` still gates install + build above, so `--no-glint`
    // keeps deps/dist present for the canonical resolver and only
    // disables Glint type extraction here.
    const useGlint = wantGlint && installed && !args.noGlint;
    const prevGlint = process.env['HVE_GLINT'];
    if (useGlint) {
      process.env['HVE_GLINT'] = '1';
    } else {
      // Must be the literal string '0' — the plugin reads
      // `process.env['HVE_GLINT'] !== '0'`, so an unset/deleted env var
      // is treated as Glint-ON (default). The previous `delete` here
      // silently re-enabled Glint for targets configured `glint: false`
      // (and for targets where install failed), filling the discourse /
      // super-rentals / cardstack-ui-components baselines with
      // Glint-resolved findings that those targets opted out of —
      // notably ~390 `<li>` substitutions from "ghost" service-driven
      // components like `<DBreadcrumbsItem>` in discourse, which
      // register with a service via `constructor()` and render nothing
      // at the call site (the actual `<li>` is emitted by a sibling
      // container component's `{{#each}}` over registered items).
      process.env['HVE_GLINT'] = '0';
    }
    let result;
    try {
      result = await validateTarget(target, repoDir);
    } finally {
      if (prevGlint === undefined) delete process.env['HVE_GLINT'];
      else process.env['HVE_GLINT'] = prevGlint;
    }
    const { files, findings } = result;
    const { errors, warnings } = countBySeverity(findings);
    process.stderr.write(
      `  files: ${files}\n  findings: ${findings.length} (errors: ${errors}, warnings: ${warnings})${useGlint ? ' (with Glint)' : ' (no Glint)'}\n`,
    );

    // Transformer/parser crashes are plugin bugs, not findings against user
    // code. They must never end up in a committed baseline — otherwise the
    // crash becomes "expected output" and the bug stops failing CI. Refuse
    // to write/diff this target's baseline if it crashed, and force a
    // non-zero exit at the end regardless of mode.
    const crashCount = findings.filter((f) => f.ruleId === '__transformer-crash__').length;
    if (crashCount > 0) {
      process.stderr.write(
        `  CRASHED: ${crashCount} transformer crash(es) — refusing to baseline; fix the plugin\n`,
      );
      crashedTargets++;
      continue;
    }

    const current: Baseline = { ref: target.ref, fileCount: files, findings };

    if (args.update) {
      writeBaseline(target.name, current);
      process.stderr.write(`  baseline updated\n`);
      continue;
    }

    const baseline = loadBaseline(target.name);
    if (!baseline) {
      process.stderr.write(`  no baseline yet — run with --update to seed\n`);
      regressions++;
      continue;
    }
    if (baseline.ref !== target.ref) {
      process.stderr.write(
        `  baseline pinned to ${baseline.ref.slice(0, 12)} but targets.json says ${target.ref.slice(0, 12)} — refusing to diff (apples-to-oranges); re-run with --update after vetting\n`,
      );
      regressions++;
      continue;
    }
    // Fewer (or more) files than the baseline saw means the glob or the
    // file lister changed, not the plugin; a findings diff would hide it.
    if (baseline.fileCount !== files) {
      process.stderr.write(
        `  baseline covered ${baseline.fileCount} files but this run found ${files} — refusing to diff; re-run with --update after vetting\n`,
      );
      regressions++;
      continue;
    }
    const { added, removed } = diffFindings(baseline.findings, findings);
    if (added.length === 0 && removed.length === 0) {
      process.stderr.write(`  no diff vs baseline\n`);
      continue;
    }
    process.stderr.write(`  REGRESSION: +${added.length} -${removed.length} vs baseline\n`);
    if (added.length > 0) {
      process.stderr.write(`\n  added:\n${summarizeFindings(added)}`);
    }
    if (removed.length > 0) {
      process.stderr.write(`\n  removed:\n${summarizeFindings(removed)}`);
    }
    regressions++;
  }

  if (crashedTargets > 0) {
    process.stderr.write(
      `\n${crashedTargets} target(s) crashed; baseline writes were skipped for those targets\n`,
    );
  }
  if (regressions > 0 && !args.update) {
    process.stderr.write(`\n${regressions} target(s) with diffs vs baseline\n`);
    process.stderr.write(`re-run with \`--update\` after vetting if the changes are intentional\n`);
  }
  if (regressions > 0 && !args.update) process.exit(1);
  if (crashedTargets > 0) process.exit(1);
  if (!args.update) {
    process.stderr.write(`\nall targets clean vs baseline\n`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`[ecosystem] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(2);
});
