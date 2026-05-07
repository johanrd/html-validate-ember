# limber — triage

Pinned at `b7d73e54c33e2dc51f1a778985851b82dcada431`. 67 files validated, 39 findings.

Grouped by rule (counts add to 39).

## no-implicit-close ×10 + close-order ×10 — misnested `<p>` containing `<ul>`/`<dl>`

Same pattern as ember-power-select: 10 `<p>` blocks contain a sibling `<ul>` or `<dl>`, which triggers HTML's "implicit `</p>`" rule. The trailing `</p>` becomes a stray end-tag.

Locations:
- `apps/repl/app/components/verify-danger.gts:155, 162`
- `apps/repl/app/templates/docs/embedding.gts:87, 102`
- `apps/repl/app/templates/docs/repl-sdk.gts:130, 150, 154, 184, 196, 203, 207, 236, 239, 253, 257, 272, 276, 291`
- `apps/repl/app/templates/error-404.gts:12, 26`

**Verdict: TP × 20** (10 misnested `<p>` blocks, two findings each).

## no-inline-style ×10 — inline styles

Locations: various components and templates in `apps/repl/`. Same pattern as ember-power-select / ember-primitives — demo/UI styles inlined.

**Verdict: TP-stylistic × 10** (track in STYLISTIC).

## aria-label-misuse ×2 — `aria-label` on `<span>`

`apps/repl/app/templates/docs/support/api.gts:14, 17`:

```gts
<span class="tag-label" aria-label="live" style="display: inline-block">⚡ live</span>
<span class="tag-label" aria-label="Refresh" style="display: inline-block">🔃 reload</span>
```

`aria-label` only applies to interactive or explicitly-roled elements; on a generic `<span>` it's typically not exposed by ATs. The author wants the emoji to be readable by screen readers but the current code likely doesn't achieve that. Either:
- Move text content to a visible string and use the emoji as decoration (`role="img" aria-label="lightning"` on the emoji span), or
- Use `<span aria-label="…">…</span>` with `role="img"` on the emoji.

**Verdict: TP × 2** real a11y issue.

## unique-landmark ×2 — multiple `<footer>` without unique names

`apps/repl/app/templates/edit/layout/status.gts:44, 52` — two `<footer>` elements (one for "last status", one for "error") without `aria-label`. When there's >1 landmark of the same role, each needs a unique accessible name.

**Verdict: TP × 2** real a11y issue.

## no-implicit-input-type ×2

`apps/repl/app/templates/docs/support/api.gts:175`, `apps/repl/app/templates/edit/share.gts:167`. Real recommendations.

**Verdict: TP × 2**.

## wcag/h32 ×1 — form missing submit

`apps/repl/app/templates/docs/support/api.gts:140`. Real.

**Verdict: TP × 1**.

## no-implicit-button-type ×1

`apps/repl/app/templates/edit/format-buttons.gts:39` on `<Option ...>` — Glint resolved Option to `<button>`, missing explicit `type`. Real.

**Verdict: TP × 1**.

## element-permitted-content ×1

`apps/tutorial/app/components/selection.gts:50` — `<style>` inside `<label>`. `<label>` permits phrasing content; `<style>` is metadata content. Strict spec violation.

**Verdict: TP-rule-strictness × 1** — similar to the ember-primitives `<style>` inside `<fieldset>` case. Defensible in practice (component-scoped CSS), out of strict spec.

## Summary

- **TP**: 28 (20 misnested `<p>` + 2 aria-label-misuse + 2 unique-landmark + 2 no-implicit-input-type + 1 wcag/h32 + 1 no-implicit-button-type)
- **TP-stylistic**: 10 (no-inline-style)
- **TP-rule-strictness**: 1 (`<style>` in `<label>`)
- **FP-plugin**: 0
- **FP-rule**: 0

No new FP-plugin patterns. The misnested-`<p>` and missing-attribute findings are real bugs worth filing.

## STYLISTIC update

- `no-inline-style`: +10 (now 20 total across 3 targets — ember-primitives, ember-power-select, limber).
