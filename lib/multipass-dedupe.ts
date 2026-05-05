// Dedupe identical messages across multiple html-validate `Result`
// entries. Multipass branch validation yields one Source per
// {{#if}}/{{else}} branch combination; an error stable across branches
// (e.g., a misnested element OUTSIDE the if/else) lands in every
// resulting `Result` and would be reported N times without dedupe.
//
// Used by the bundled `validate-gts` CLI and by the integration-test
// helper. Direct html-validate consumers (the VS Code extension, the
// `html-validate` CLI used standalone) don't dedupe and may want to
// set `HVE_MAX_CONDITIONAL_BRANCHES=0` to fall back to single-branch
// emission.

import type { Report, Result } from 'html-validate';
import { __multipassBranchedRanges } from '../transform.js';

export interface DedupedReport {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  results: Result[];
}

// Rules whose semantics don't compose with branch-by-branch
// validation: a directive used in branch A looks unused in branch B,
// a form with a submit in branch A looks submit-less in branch B, etc.
// The user's mental model is the union of branches; multipass treats
// each as a separate runtime DOM. Within branched template ranges
// (see `__multipassBranchedRanges`), drop these rules from the merged
// report. Outside those ranges (non-branched templates in the same
// file, or non-branched files entirely), the rules fire normally.
// Users wanting them on branched ranges too can set
// `HVE_MAX_CONDITIONAL_BRANCHES=0`.
//
// Future caution: this is a coarse hammer — it drops the rule for any
// message inside a branched range, regardless of what else is going
// on. It works for `no-unused-disable` because the rule's failure
// mode under multipass is unconditional FP within a branched range.
// Rules with sharper trade-offs (e.g., `wcag/h32`, which can also
// fire on a *genuinely* missing submit in a non-opaque branch) need
// per-pass tracking — see the discussion in the PR that introduced
// this constant. Don't reach for this list reflexively.
const MULTIPASS_INCOMPATIBLE_RULES: ReadonlySet<string> = new Set([
  'no-unused-disable',
]);

/**
 * Returns a copy of `report` with messages deduped by
 * `(line, column, ruleId, message)` across every `Result`. Counts are
 * recomputed from the deduped messages. The original `report` is not
 * mutated.
 */
export function dedupeMultipassReport(report: Report): DedupedReport {
  const seen = new Set<string>();
  const results: Result[] = report.results.map((r) => {
    const ranges = __multipassBranchedRanges.get(r.filePath) ?? [];
    const inBranched = (line: number): boolean =>
      ranges.some(([s, e]) => line >= s && line <= e);
    return {
      ...r,
      messages: r.messages.filter((m) => {
        if (MULTIPASS_INCOMPATIBLE_RULES.has(m.ruleId) && inBranched(m.line)) {
          return false;
        }
        const k = `${m.line}:${m.column}:${m.ruleId}:${m.message}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
    };
  });
  for (const r of results) {
    __multipassBranchedRanges.delete(r.filePath);
  }
  let errorCount = 0;
  let warningCount = 0;
  for (const r of results) {
    for (const m of r.messages) {
      if (m.severity === 2) errorCount++;
      else if (m.severity === 1) warningCount++;
    }
    // Update per-result counts too so html-validate's formatter sees
    // consistent numbers.
    r.errorCount = r.messages.filter((m) => m.severity === 2).length;
    r.warningCount = r.messages.filter((m) => m.severity === 1).length;
  }
  return {
    valid: errorCount === 0 && warningCount === 0,
    errorCount,
    warningCount,
    results,
  };
}
