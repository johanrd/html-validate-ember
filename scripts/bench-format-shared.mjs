/**
 * Shared by the CLI and PR-comment formatters: time formatting, the delta
 * classification, and pairing of `(control)` / `(experiment)` runs.
 */

export function formatTime(ns) {
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(2)} ns`;
}

// Negative pct means the experiment is faster (lower time is better).
// Identical code measures within about ±3 % on a shared CI runner.
export function deltaEmoji(pct) {
  const abs = Math.abs(pct);
  if (abs < 5) return '⚪';
  if (pct <= -10) return '🟢';
  if (pct >= 10) return '🔴';
  return '🟡';
}

export const LEGEND = '🟢 faster · 🔴 slower · 🟡 5–10 %, possibly noise · ⚪ within 5 %';

/**
 * Rows of { name, control, experiment, delta } from the bench JSON, using
 * p50 — far more robust to GC pauses and noisy neighbours than the mean.
 */
export function comparisonRows(json) {
  const pairs = new Map();
  for (const trial of json.benchmarks ?? []) {
    for (const r of trial.runs ?? []) {
      if (!r.stats) continue;
      const m = r.name.match(/^(.+)\s+\((control|experiment)\)$/);
      if (!m) continue;
      const [, key, role] = m;
      if (!pairs.has(key)) pairs.set(key, {});
      pairs.get(key)[role] = r.stats;
    }
  }
  const rows = [];
  for (const [name, { control, experiment }] of pairs) {
    if (!control || !experiment) continue;
    const ctrl = control.p50 ?? control.avg;
    const exp = experiment.p50 ?? experiment.avg;
    rows.push({ name, control: ctrl, experiment: exp, delta: ((exp - ctrl) / ctrl) * 100 });
  }
  return rows;
}
