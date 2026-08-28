# Ecosystem CI

Runs `html-validate-ember` against pinned snapshots of public Ember repos and diffs the findings against committed baselines. Locally a non-empty diff fails `ecosystem:check`; in CI the run is opt-in and refreshes the baselines on drift (see [Running in CI](#running-in-ci)).

## What's here

- `targets.json` — the list of pinned repos (owner/repo + SHA + globs + per-target options).
- `run.ts` — the runner. Clones, installs deps, validates with Glint, diffs. The validation config (`makeValidator`) extends the plugin's shipped `:gts-recommended` preset and then layers `ECOSYSTEM_RULE_OVERRIDES` on top — a few stylistic rules (`void-style`, `no-inline-style`, `prefer-native-element`) suppressed *here, in the CI config, not in the plugin* so style noise doesn't drown the regression signal across the targets.
- `baselines/<name>.json` — committed expected output per target. The runner refuses to diff if the baseline's pinned SHA disagrees with `targets.json`.

Cached clones (with their installed `node_modules`) live in `.cache/` (gitignored).

## Running in CI

The `ecosystem` workflow is **opt-in** — it clones a dozen real-world repos and installs their deps (~20 min cold), so it doesn't run on every PR. Trigger it by:

- adding the **`run-ecosystem-ci`** label to a PR — the label can be added *after* the PR is opened and still kicks off a run; remove it to stop re-running on pushes; or
- dispatching it manually from the Actions tab (`workflow_dispatch`).

On a labeled PR the job runs `ecosystem:check`. If findings drift from the committed baselines it **refreshes the baselines, commits them back to the PR branch**, and fails the job — so the baseline JSON diff lands inline in the PR's *Files changed* for review. Merge if the change is intended (the refreshed baselines are already committed); if it's an unintended regression, fix the plugin instead. The bot's commit uses `GITHUB_TOKEN`, which doesn't re-trigger CI, so it can't loop.

## Glint

By default each target is validated with Glint on (`HVE_GLINT=1`). That requires the target's deps installed locally — Glint resolves `@glint/ember-tsc` and the target's TypeScript types from the target's own `node_modules`. The runner detects the package manager from the lockfile and installs with `--ignore-scripts`. If install fails the runner falls back to no-Glint validation for that target and prints a warning rather than failing the run.

Per-target opt-out: set `"glint": false` on a target in `targets.json` (e.g., for repos where install doesn't work cleanly or isn't worth the time).

## Local commands

```bash
npm run ecosystem:check                       # all targets, fail on diff
npm run ecosystem:check -- --target=limber    # just one
npm run ecosystem:check -- --target=a,b,c     # subset
npm run ecosystem:check -- --no-clone         # skip clone/fetch (faster, uses .cache)
npm run ecosystem:update                      # rewrite all baselines
npm run ecosystem:update -- --target=foo      # rewrite one
```

## When to update a baseline

You're working on the plugin and a real-world target's findings changed. That's the signal — the diff is the value statement of the change. Inspect the `added:` and `removed:` blocks in the runner output:

- **Removed findings** (fewer reports) — usually a fix landed; a FP got eliminated. Good. Update the baseline in the same PR; reviewer sees what disappeared.
- **Added findings** (new reports) — either the plugin now catches something it didn't before (good — explain in the PR), or it's a regression (don't update the baseline; fix it).

The runner's diff output is the input to the PR description. Don't paraphrase it; paste the relevant lines.

## Bumping target SHAs

Manual for now. Re-fetch the default branch's HEAD, update `ref` in `targets.json`, run `npm run ecosystem:update -- --target=<name>`, commit baseline + targets.json together. The diff in the PR shows what changed in the target's templates between the old and new SHA — those are upstream-side changes, not plugin-side, but they're still worth reading: they're candidates for issue drafts to file with the upstream repo.

If a baseline is committed against a different SHA than `targets.json`, the runner refuses to diff (apples-to-oranges) and asks you to re-baseline. This guards against forgetting the second commit.

## Triage flow (separate from CI)

The committed baselines contain a mix of real bugs, plugin FPs, and html-validate rules that fire on legitimate Ember patterns. Triaging them is *not* what CI does — CI only catches regressions. Triage is a manual, batched activity that produces:

1. **Plugin fixes** for the FPs (which then show up as `removed:` in the next baseline update).
2. **Issue drafts** for the real bugs in the target repos (one per repo, batched, you file).

The expected workflow is to triage one target at a time, file an issue with the upstream repo if findings warrant it, and let the natural flow of plugin fixes update baselines over time.

## Adding a target

1. Pick a repo with non-trivial templates (`.gts`/`.gjs`/`.hbs`).
2. Probe its layout: `git clone --depth=1 --filter=blob:none <url> /tmp/probe && find /tmp/probe -name '*.gts' -o -name '*.gjs' -o -name '*.hbs' | head`.
3. Pin the current default-branch SHA: `git ls-remote <url> HEAD`.
4. Add a target entry. Globs should cover *real* templates (addon source + docs/test apps), not test fixtures (those often contain intentionally broken HTML for integration tests).
5. `npm run ecosystem:update -- --target=<name>` to seed the baseline.
6. Commit `targets.json` and `baselines/<name>.json` together.

## Why bake findings into the baseline rather than gate on zero findings

These targets have hundreds of real-world findings — some genuine, some plugin FPs, some debatable a11y choices. Refusing to merge any plugin change that doesn't drive findings to zero is impractical (the targets are out of our control). Refusing changes that *introduce* new findings is tractable. So the baseline is "current state", and the CI signal is "did this PR change real-world output, and is the change intentional?".
