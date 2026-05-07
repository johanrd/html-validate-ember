# ember-website — triage

Pinned at `43ac579887f0722e0dc321392ecbab0affb49f34`. 73 files validated, 279 findings.

This is the largest target after HDS. Findings cluster heavily by rule; triage by cluster rather than per-finding.

## void-style ×153 — `<br>`/`<input>`/`<img>` not self-closing

The site is largely classic `.hbs` templates that consistently use the *omitted* end-tag form (`<br>`, `<input>`, `<img>`). The plugin's `:gts-recommended` enforces `selfclosing`. Pure stylistic disagreement.

**Verdict: TP-stylistic ×153** (track in STYLISTIC). Largest single rule on this target — strong default-off candidate confirmation.

## element-permitted-content ×99 — addon-component `<li>` resolution gap

Distribution:

| File | Count |
|---|---|
| `app/templates/survey/2018.hbs` | 20 |
| `app/templates/browser-support.hbs` | 18 |
| `app/templates/survey/2017.hbs` | 16 |
| `app/templates/survey/2019.hbs` | 12 |
| `app/templates/survey/2020.hbs` | 12 |
| `app/templates/index.hbs` | 10 |
| `app/templates/learn/examples.hbs` | 5 |
| `app/templates/learn/index.hbs` | 5 |
| `app/components/index/ember-addons.hbs` | 1 |

98/99 are `<EsCard>` (from `ember-styleguide` addon) used as list items inside `<ul>`. EsCard's template is `<li class="card" ...attributes>...</li>` — at runtime `<EsCard>` IS a `<li>`, and `<p>`/`<blockquote>`/`<div>`/`<ul>` inside is allowed. Our plugin transparent-blanks `<EsCard>` (no JS-side `Signature['Element']` to resolve from — it's a classic Ember addon component with `.hbs` template), so children float to `<ul>` directly and html-validate fires `element-permitted-content`.

**Verdict: FP-plugin ×98** — same root-tag-resolution gap as ember-a11y-testing's TOC case but for classic Ember addons (`.hbs` templates, no JS types).

The remaining 1 finding (`app/components/index/ember-addons.hbs:41`) is `<pre>` inside `<code>` — different cause. `<code>` is phrasing content; `<pre>` is flow content. Real spec violation.

**Verdict: TP × 1** for that one.

## attribute-boolean-style ×7 — `checked="checked"` style

7 instances in mascots/ templates. `checked="checked"`/`required="required"` etc. — pure stylistic preference (omit the value vs. use the attribute name as value). HTML allows both.

**Verdict: TP-stylistic ×7** (track in STYLISTIC).

## form-dup-name ×6 — duplicate `name` on form controls

`app/templates/mascots/commission.hbs` — multiple form controls share `name="Field8"` (and similar). Real bug: form submission sends ambiguous data.

**Verdict: TP × 6**.

## no-conditional-comment ×4 — `<!--[if IE]>` style

`app/templates/mascots/payment.hbs:184, 190, 192, ...`. Old IE compatibility comments. Deprecated; modern browsers ignore. Likely obsolete code in a payment form template.

**Verdict: TP × 4** (cleanup recommendation; no functional impact since modern browsers skip them).

## prefer-button ×2 — `<input type="submit">` vs `<button>`

`app/templates/mascots/commission.hbs:207`, `app/templates/mascots/payment.hbs:276`. Stylistic preference; both are valid form-submit buttons.

**Verdict: TP-stylistic ×2** (track in STYLISTIC).

## no-deprecated-attr ×2

- `app/templates/community/index.hbs:118` — `frameborder` on `<iframe>` (deprecated HTML4 attribute; CSS replaces it)
- `app/templates/community/meetups/index.hbs:67` — `align` on `<img>` (deprecated; CSS replaces it)

**Verdict: TP × 2**.

## no-implicit-close ×1 + close-order ×1

Same misnested-`<p>` pattern as ember-power-select / limber. 1 block, 2 findings.

**Verdict: TP × 2**.

## element-name ×1 — `<image>` is not a valid element

`app/templates/index.hbs:137`. Almost certainly a typo for `<img>`. Real bug.

**Verdict: TP × 1**.

## no-inline-style ×1

One inline-style somewhere. Real but trivially stylistic.

**Verdict: TP-stylistic × 1**.

## aria-label-misuse ×1

`app/templates/learn/index.hbs:3` — `aria-labelledby` on an element that doesn't allow it. Real a11y issue.

**Verdict: TP × 1**.

## attribute-allowed-values ×1

One invalid attribute value. Real.

**Verdict: TP × 1**.

## Summary

- **TP** (real): 18 (1 EPC `<pre>` in `<code>` + 6 form-dup-name + 4 no-conditional-comment + 2 no-deprecated-attr + 2 misnested `<p>` + 1 element-name + 1 aria-labelledby + 1 attribute-allowed-values + 1 inline-style)

  Wait — counting again: 1 + 6 + 4 + 2 + 2 + 1 + 1 + 1 = 18. Correct.

  Plus the 1 inline-style is stylistic, so TP-real = 17.

- **TP-stylistic**: 163 (153 void-style + 7 attribute-boolean-style + 2 prefer-button + 1 no-inline-style)
- **FP-plugin**: 98 (`<EsCard>` and similar addon components without JS-side root-tag info)
- **FP-rule**: 0

## Plugin work this surfaces

**New FP pattern (third flavor of root-tag resolution)**: classic Ember addon components with `.hbs` templates (no JS-side `Signature['Element']` and no `satisfies TOC<{Element: ...}>`) cannot have their root tag inferred. The fix path is similar to the existing `getSplattedRootsForFile` machinery (which walks `.gts` for splatted-root analysis): extend it to walk `.hbs` files in `node_modules/<addon>/{addon,app}/templates/components/<dasherized>.hbs`, parse the root element, and feed it into the same `componentTagMap`.

This is a substantial extension because:
- We need to resolve component-name → addon-template-path. PascalCase + dot-notation isn't a 1:1 mapping; it follows Ember's component lookup rules and depends on addon layout (addon vs app, classic vs MU).
- Addon templates may have `...attributes` on a wrapping element with multiple potential root candidates.
- We'd be reading from the consuming project's `node_modules`, similar to how Glint uses `createRequire` from the file's location.

Will be added to FP-FIX-REPORT as a separate entry. May not fix in this branch — track on `failing-test/fp-classic-addon-template-resolution` if the implementation is too invasive.

## STYLISTIC update

Massive bumps:
- `void-style`: +153 (now 159 across 2 targets — super-rentals + ember-website). Strong default-off candidate.
- `attribute-boolean-style`: +7 (new; 1 target).
- `prefer-button`: +2 (new; 1 target).
- `no-inline-style`: +1 (now 21 across 4 targets).
