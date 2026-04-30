// Dedupe identical messages across multiple html-validate `Result`
// entries. Multipass branch validation yields one Source per
// {{#if}}/{{else}} branch combination; an error stable across branches
// (e.g., a misnested element OUTSIDE the if/else) lands in every
// resulting `Result` and would be reported N times without dedupe.
//
// Used by the bundled `validate-gts` CLI and by the integration-test
// helper. Direct html-validate consumers (the VS Code extension, the
// `html-validate` CLI used standalone) don't dedupe and may want to set
// `HVE_MULTIPASS=0` to fall back to single-branch emission.

import type { Report, Result } from 'html-validate';

export interface DedupedReport {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  results: Result[];
}

/**
 * Returns a copy of `report` with messages deduped by
 * `(line, column, ruleId, message)` across every `Result`. Counts are
 * recomputed from the deduped messages. The original `report` is not
 * mutated.
 */
export function dedupeMultipassReport(report: Report): DedupedReport {
  const seen = new Set<string>();
  const results: Result[] = report.results.map((r) => ({
    ...r,
    messages: r.messages.filter((m) => {
      const k = `${m.line}:${m.column}:${m.ruleId}:${m.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  }));
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
