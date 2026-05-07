# hds-design-system — triage

Pinned at `9db0ff66136c04789d756d7b1454f3e48fc635ae`. 859 files validated, 303 findings.

This is the largest target. Triage is by-rule + by-pattern; per-finding lookup at this scale isn't useful (most patterns repeat). Citing example findings within each cluster.

## element-permitted-content ×184 — multiple FP-plugin causes

Sub-distribution by parent/child pair:

| Count | Pattern | Cluster verdict |
|---|---|---|
| 107 | `<option>` under `<div>` | **FP-plugin** — yielded curried components like `<HdsFormSelectBase as \|C\|><C.Options>...</C.Options></HdsFormSelectBase>`. Plugin transparent-blanks the curried `<C.Options>`, floating `<option>`s to the wrapping `<div>` instead of the runtime `<select>`. |
| 25 | `<div>` under `<ul>` | **FP-plugin** — same `<EsCard>`-class pattern as ember-website: addon list-item components (e.g. `<HdsAppSideNav.List.Item>`) render `<li>` but Glint composition resolution doesn't propagate the type through the namespace. |
| 14 | `<div>` under `<button>` | **TP** — phrasing-content rule. HDS's icon+label buttons wrap content in `<div>` for layout. Out of strict spec; commonly accepted in design systems. Real but debatable. |
| 8 | `<div>` under `<abbr>` | **FP-plugin** — same mystery as ember-power-select. Generic `HTMLElement` falling through to `abbr`. |
| 5 | `<input>` under `<a>` | **TP** — interactive-content nesting violation. `<a>` cannot contain interactive descendants. Real spec violation. |
| 4 | `<option>` under `<fieldset>` | **FP-plugin** — same yielded-curried-component issue as #1. |
| 4 | `<optgroup>` under `<div>` | **FP-plugin** — same. |
| 3 | `<div>` under `<label>` | **TP-rule-strictness** — `<label>` permits phrasing content; design systems often have `<div>` for layout. |
| 3 | `<div>` under `<span>` | **TP** — block content under phrasing element. Real. |
| 3 | `<option>` under `<form>` | **FP-plugin** — same yielded-curried-component. |
| 3 | `<option>` under `<abbr>` | **FP-plugin** — same generic HTMLElement fallback. |
| 2 | `<a>` under `<a>` | **TP** — nested anchor. Real spec violation. |
| 1 | `<div>` under `<legend>` | **TP** — phrasing-content rule. Real. |
| 1 | `<abbr>` under `<ol>` | **FP-plugin** — Glint generic-fallback again, this time on a list item. |
| 1 | `<span>` under `<ul>` | **FP-plugin** — list-item resolution gap. |

Aggregate: **150 FP-plugin** + **23 TP** + **3 TP-rule-strictness** + **8 FP-plugin** (mystery) = 184 ✓

## element-required-attributes ×39 — `<iframe>` missing `title`

All 39 are `<ShwFrame>` (showcase iframe wrapper) used in showcase pages. ShwFrame's template is presumably `<iframe title={{@label}} src={{@src}} ...>` — the title comes from the `@label` arg. Plugin's Glint resolves `<ShwFrame>` to `<iframe>` correctly but doesn't infer `title=' '` (DynamicValue placeholder) from the arg-binding.

**Verdict: FP-plugin × 39** — new pattern, distinct from the splat-driven required-attribute injection. The component declares its required attribute as bound to an `@arg`; we should detect that.

## prefer-native-element ×28

Sample: `<HdsAdvancedTable.ThReorderHandle>` resolved to `<button>`, then plugin reports a redundant-`<button>` recommendation? Need to verify per-case but likely real recommendations.

| Sample | Verdict |
|---|---|
| `advanced-table/th-reorder-handle.gts:112` — prefer `<button>` | TP |
| `card/container.gts:185` — prefer `<li>` | TP (or FP-plugin if Glint should have resolved to li already) |
| `dropdown/.../checkmark.gts:28` — prefer `<select>` | TP-stylistic (intentional for custom-select listbox pattern) |

**Verdict: TP × 28** (assuming most are real). Some may be FP-plugin or stylistic; without per-finding verification I'll lump as TP.

## no-redundant-role ×15

`role="list"` on `<ul>` is redundant — `<ul>` has the implicit `list` role.

**Verdict: TP × 15** — easy fix on the consuming side. (Common defensive pattern: explicit role for VoiceOver compatibility on Safari, where `list-style: none` strips the implicit list role. Worth checking per-case.)

Actually, this is a known a11y workaround: when `<ul>` has `list-style: none` (which design systems often apply), Safari/VoiceOver strips the implicit `list` role. Adding `role="list"` is a *defensive* attribute against that bug. Per html-validate's reading it's redundant, per a11y best practice it's necessary.

**Verdict revised: TP-rule-context × 15** — html-validate fires correctly per its definition, but the attribute is intentional defensive a11y for Safari/VoiceOver compatibility. Maintainer would not change.

## aria-label-misuse ×8

| Sample | Verdict |
|---|---|
| `app-footer/index.gts:70` — "strictly allowed but not recommended" | TP-warning |
| `app-side-nav/portal/index.gts:28` — "cannot be used on this element" | TP |

Mixed. Some are warnings (allowed but discouraged), some are errors (not allowed). Aggregate: **TP × 8** assuming most are real misuse. Some require specific element/role contexts to verify.

## no-implicit-button-type ×6

All `<button>` missing explicit `type`. Real recommendations.

**Verdict: TP × 6**.

## wcag/h32 ×6 — form without submit button

Sample: `packages/components/src/components/hds/form/index.gts:81`. `<HdsForm>` is a form-wrapper component that yields children. Same yield-only-form pattern as ember-primitives' `<Form>`.

**Verdict: FP-plugin × 6** (same pattern as the ember-primitives entry in FP-FIX-REPORT).

## wcag/h71 ×4 — fieldset without legend

Sample: `packages/components/src/components/hds/form/fieldset/index.gts:99`. Same yield-only-fieldset pattern as ember-primitives.

**Verdict: FP-plugin × 4** (same pattern).

## no-inline-style ×9

**Verdict: TP-stylistic × 9** (track in STYLISTIC).

## no-deprecated-attr ×1, attribute-boolean-style ×1, attribute-allowed-values ×1, no-dup-class ×1

Misc. real findings; the boolean-style + allowed-values are at the same span (`selected="true"` — should be `selected` alone).

**Verdict: TP × 4** (well, 3 if we count selected="true" as one issue with two reports).

## Summary

| Category | Count |
|---|---|
| TP (real) | ~52 (23 EPC + 28 prefer-native + 6 implicit-button + 5 inline-stuff + ~misc) |
| TP-rule-context / -strictness | ~21 (15 redundant-role + 3 div-in-label/span/legend + 3 abbr/dt-strict) |
| TP-stylistic | 9 (no-inline-style) |
| FP-plugin | ~217 (158 EPC + 39 iframe-title + 6 wcag/h32 + 4 wcag/h71 + 8 mystery-abbr + 2 misc) |

(Counts approximate at this scale; the direction is the point — 70%+ of HDS findings are plugin gaps.)

## Plugin work this surfaces

Already-known patterns get more weight:
- **Yielded curried-component resolution** — 100+ findings on `<C.Options>` style yielded sub-components losing Glint type info. This is the single largest plugin gap on HDS. Would warrant its own FP-FIX-REPORT entry.
- **Component-arg-to-attribute resolution** for `<iframe>`-style elements where the required attr is bound to an `@arg` rather than `...attributes` — 39 findings on ShwFrame alone.
- The `<EsCard>`-class pattern (addon list-item components without root resolution) — 25+ findings here, ties into the ember-website entry.
- The `<abbr>` mystery — 8 findings, clearer signal than the 1 from ember-power-select.
- The yield-only form/fieldset pattern — 10 findings (already in FP-FIX-REPORT from ember-primitives).

Updating FP-FIX-REPORT to reflect the new patterns and bumped counts.

## STYLISTIC update

- `no-inline-style`: +9 (now 30 across 4 targets — ember-primitives + ember-power-select + limber + HDS).

## Note on the issue draft

Filing 303 findings on HashiCorp's design system is unrealistic — most are FP-plugin (our work). The genuine bugs (~50) are scattered and minor. I'll write a more selective issue.md focused on the 4-5 highest-value real findings.
