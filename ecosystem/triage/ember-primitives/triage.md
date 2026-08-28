# ember-primitives — triage

Pinned at `b8a890e912e74a0241dbb321ca8750c9b7ce3ffb`. 58 files validated, 13 findings.

| # | File | Line | Rule | Verdict | Notes |
|---|------|------|------|---------|-------|
| 1 | `docs-app/app/templates/index.gts` | 54 | `no-inline-style` | TP-stylistic | Real inline `style` on `<div>`. Doc landing page; inline styles common in static demo pages. |
| 2 | `docs-app/app/templates/index.gts` | 60 | `no-inline-style` | TP-stylistic | Same |
| 3 | `docs-app/app/templates/index.gts` | 68 | `no-inline-style` | TP-stylistic | Same; `<em style="text-transform: uppercase; ...">` |
| 4 | `docs-app/app/templates/index.gts` | 241 | `no-inline-style` | TP-stylistic | Same |
| 5 | `ember-primitives/src/components/accordion/content.gts` | 18 | `prefer-native-element` (`<section>`) | TP-stylistic | `<div role="region" id={{@value}} ...>` — could be `<section>`, but `<section>` requires accessible name and the API provides one via `id`. Defensible either way. |
| 6 | `ember-primitives/src/components/accordion/header.gts` | 20 | `prefer-native-element` (`<h*>`) | TP | `<div role="heading" aria-level="3">` should be `<h3>` per WCAG (or whichever level the consumer needs). Real recommendation. |
| 7 | `ember-primitives/src/components/form.gts` | 66 | `wcag/h32` | **FP-plugin** | `<form ... ...attributes>{{yield}}</form>` — submit button comes from consumer (yielded children + ...attributes). Plugin sees blanked yield and concludes "no submit"; runtime DOM has consumer-provided submit. |
| 8 | `ember-primitives/src/components/one-time-password/input.gts` | 171 | `wcag/h71` | **FP-plugin** | `<fieldset ...attributes>{{yield CurriedFields}}...</fieldset>` — `<legend>` may come from consumer via yield. Same yield-content-invisible pattern as #7. |
| 9 | `ember-primitives/src/components/one-time-password/input.gts` | 183 | `element-permitted-content` (`<style>` under `<fieldset>`) | TP-rule-strictness | Inline `<style>` for screen-reader-only CSS, scoped to component output. Per strict spec `<style>` inside body is awkward; per modern parser it works. Real per html-validate's reading; debatable in practice. |
| 10 | `ember-primitives/src/components/one-time-password/otp.gts` | 119 | `wcag/h32` | **FP-plugin** | Same form-with-yield-and-splat as #7. |
| 11 | `ember-primitives/src/components/progress.gts` | 134 | `prefer-native-element` (`<progress>`) | TP | `<div role="progressbar" aria-valuemax={{this.max}} ...>` — should be `<progress max={{this.max}} value={{this.value}}>` for proper semantics + automatic announcements. |
| 12 | `ember-primitives/src/components/rating/rating.gts` | 160 | `wcag/h71` | **FP-plugin** | `<fieldset {{on "click" ...}} ...attributes>{{#let ...}}...{{/let}}</fieldset>` — body is dynamic; `<legend>` may be in `{{#let}}` body or yielded. |
| 13 | `ember-primitives/src/components/rating/stars.gts` | 53 | `input-attributes` | TP | `<input type="radio" readonly={{@isReadonly}}>` — `readonly` is not valid on `<input type="radio">` (only on text-like inputs). Should use `disabled` instead. |

## Summary

- **TP** (real bugs): 3 — accordion-header non-semantic heading, progress non-semantic role, radio readonly misuse
- **TP-stylistic**: 5 — 4× `no-inline-style` in docs, 1× `prefer-native-element` (region) in accordion
- **TP-rule-strictness**: 1 — `<style>` inside `<fieldset>` (debatable interpretation)
- **FP-plugin**: 4 — form/fieldset structural rules firing despite `{{yield}}` + `...attributes` allowing consumer-provided structure
- **FP-rule**: 0

## Plugin work this surfaces

**New FP pattern**: structural-content rules (`wcag/h32` for form-needs-submit, `wcag/h71` for fieldset-needs-legend) fire on container elements whose body is `{{yield}}` (and/or that accept `...attributes`). The plugin blanks `{{yield}}` to whitespace; html-validate sees an empty body and reports the missing required child. At runtime the consumer fills the body.

This is the *same shape* as the multipass yield-only-branch heuristic (`form-submit-in-else.gts`, `multipass-yield-only-branch.gts`) but for non-multipass templates: a single-template component whose body is yield-only.

Will be added to FP-FIX-REPORT.

## STYLISTIC tracking update

- `no-inline-style`: +4 (now 4 total across 1 target — only ember-primitives docs).
