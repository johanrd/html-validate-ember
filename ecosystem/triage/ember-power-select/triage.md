# ember-power-select — triage

Pinned at `bf21b6c08ff87c1921f9fb19d200f994fdfea28c`. 114 files validated, 34 findings. Grouped by rule (counts add to 34).

## prefer-native-element ×12 — `<div role="button">` tabs in `code-example.gts`

`docs/app/components/code-example.gts` lines 53, 60, 67, 74, 81, 88, 95, 102, 109, 116, 123, 130 — twelve sibling `<div role="button" {{on "click" ...}}>Template</div>` blocks for switching between code examples.

```gts
<div
  class="code-example-tab {{if (eq this.activeTab 'glimmer-ts') 'active'}}"
  role="button"
  {{on "click" (fn this.setActiveTab "glimmer-ts")}}
>Template</div>
```

**Verdict: TP** — anchor/div-as-button anti-pattern. Native `<button type="button">` gives keyboard semantics for free; `role="button"` requires manual handling for Space/Enter activation, focus, etc. (Arguably could also be `role="tab"` since they're inside `<nav class="code-example-tabs">` — would warrant proper tablist semantics with `aria-selected`.)

## no-implicit-close ×7, close-order ×7 — `<p>` containing block elements

Pattern: `<p>...<ul>...</ul>...</p>` or similar, where `<ul>`/`<dl>` triggers HTML's "implicit `</p>`" rule. The browser auto-closes the `<p>` before the `<ul>`, then the explicit `</p>` later becomes a stray end tag.

```hbs
<p>
  In plain English, ...
  <ul>
    <li>...</li>
  </ul>
</p>
```

Locations: `docs/app/templates/public-pages/cookbook/css-animations.gts:48,56`, `docs/app/templates/public-pages/docs/architecture.gts:16,24,84,102,...`.

**Verdict: TP × 14** (7 implicit-close + 7 close-order, same root cause: 7 misnested `<p>` blocks). Real spec violation; renders OK in browsers but invalidates the intended document structure.

## no-inline-style ×6

Locations: `demo-app/components/custom-multiple-search-placeholder.gts:14`, `custom-placeholder.gts:12`, `docs/app/components/snippets/action-handling-5.gts:40`, plus 3 more.

Sample: `<span style="font-weight:bold">bold</span>` — demo placeholder showcase.

**Verdict: TP-stylistic ×6** (track in STYLISTIC).

## element-permitted-content ×2

| Loc | Detail | Verdict |
|---|---|---|
| `docs/app/templates/public-pages/docs/troubleshooting.gts:30` | `<br>` inside `<ol>` (between `<li>` items, used as visual spacing) | **TP** — `<ol>` only permits `<li>`. The author wants visual gap; should be CSS `margin-bottom` on `<li>`. |
| `src/components/power-select.gts:1443` | `<div>` not permitted under `<abbr>` | **FP-plugin-suspect** — there's no literal `<abbr>` in the file. An ancestor component is being Glint-resolved to `<abbr>`, which seems wrong. Worth investigating but not blocking. |

## Summary

- **TP**: 27 (12 div-as-button tabs, 14 misnested `<p>`s, 1 `<br>` in `<ol>`)
- **TP-stylistic**: 6 (`no-inline-style`)
- **FP-plugin** (suspect, needs investigation): 1 (mysterious `<abbr>` resolution at `power-select.gts:1443`)
- **FP-rule**: 0
- **intentional**: 0

## Plugin work this surfaces

**1 FP-plugin-suspect**: at `src/components/power-select.gts:1443:12`, html-validate reports `<div>` not permitted under `<abbr>`. The file contains no literal `<abbr>`. An ancestor component (`<this.triggerComponent>` and/or similar) is being resolved by Glint to the `abbr` tag, presumably because the component's declared `Signature['Element']` resolves to a TypeScript `HTMLElement` (the generic) rather than a specific subtype, and the plugin's fallback maps that to `abbr`.

Add to FP-FIX-REPORT for investigation; a scoped repro fixture would help. May be a known limitation of the element-class → tag-name mapping when faced with `HTMLElement` (not a specific subclass).

## STYLISTIC update

- `no-inline-style`: +6 (now 10 total across 2 targets — ember-primitives + ember-power-select).
