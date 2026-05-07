# Aggregate FP-fix report

Plugin-side false positives surfaced by ecosystem CI triage. Each entry summarizes a *pattern* (one or many findings across one or many targets) with a concrete fix path.

## Status legend

- 🔴 OPEN — not yet fixed
- 🟢 FIXED — landed in a PR; baseline updated reflects the drop

---

## 🔴 `<img ...attributes>` triggers `element-required-attributes` (`src`) and `wcag/h37` (`alt`)

**Affected targets:** super-rentals (2 findings); pending review for others.

**Pattern.** Plugin blanks `...attributes` (it's classified as Glimmer-only at `blank.ts:130`), then html-validate sees `<img>` with no attributes and fires the required-attribute rules. At runtime the splat provides `src`/`alt` from the consumer; we just can't see that statically.

**Fix.** Symmetric to the `<input type=' '>` injection in `blank.ts:644-648`: when a `...attributes` splat is present on `<img>` (or any void native with required attrs), inject synthetic `src=' '` and `alt=' '` (or generally, the rule-required attrs for that element) into Glimmer-attr blank regions. html-validate then sees "attribute present, value unknowable" via `processAttribute`'s DynamicValue conversion.

**Generalization.** Same shape applies to other void natives with required attrs that are commonly splat-supplied: `<source>` (`src`), `<track>` (`src`, `kind`), `<area>` (`alt`, `coords`), `<iframe>` (`src`, `title`). Worth designing the fix generically: for any element with `...attributes`, inject placeholders for ALL element-required attributes the host rule schema declares missing.

---

## 🔴 TOC components with `satisfies TOC<{Element: ...}>` aren't Glint-resolved

**Affected targets:** ember-a11y-testing (4 findings: `<button>`, `<input>`, `<code>`, `<img>` flagged as not permitted under `<ul>`, all because `<ViolationsGridItem>` — which renders `<li>` — wasn't resolved to `li`); pending review for others.

**Pattern.** Glint's `Signature['Element']` resolution works for the class form (`class Foo extends Component<Sig>` with `Sig['Element'] = HTMLButtonElement` — covered by `test/glint-fixtures/typed-button.gts`) but not for the TOC form:

```ts
const ViolationsGridItem = <template>
  <li class="..." ...attributes>{{yield}}</li>
</template> satisfies TOC<{
  Element: HTMLLIElement;
  Args: { title: string };
  Blocks: { default: [] };
}>;
```

When Glint can't resolve the component to a native tag, the plugin falls back to transparent blanking, which floats the children up to the *actual* parent. In this case the actual parent is `<ul>`, so html-validate's `element-permitted-content` correctly observes `<button>` directly inside `<ul>` (not allowed) — but the runtime DOM has `<button>` inside `<li>` inside `<ul>` (legal). FP.

**Fix.** Extend `lib/glint.ts` to recognize the `satisfies TOC<{Element: T}>` pattern when extracting `componentTagMap`. The TOC type is from `@ember/component/template-only`; its second type parameter shape is `{ Element?: ...; Args?: ...; Blocks?: ... }`. Resolution can use the existing element-class → tag-name mapping; only the discovery step changes.

**Test.** Add a fixture in `test/glint-fixtures/` (e.g., `toc-list-item.gts`) and a consumer that uses it inside `<ul>`. Test asserts `componentTagMap` resolves to `'li'`.

---

## 🔴 Structural-content rules fire on `<form>`/`<fieldset>` whose body is `{{yield}}` + `...attributes`

**Affected targets:** ember-primitives (4 findings: 2× `wcag/h32`, 2× `wcag/h71`); hds-design-system (10 findings: 6× `wcag/h32` on `<HdsForm>`, 4× `wcag/h71` on `<HdsForm.Fieldset>`).

**Pattern.** When a Glimmer component's template is `<form ... ...attributes>{{yield}}</form>` (or the `<fieldset>` equivalent), the plugin blanks `{{yield}}` to whitespace. html-validate then sees an empty body and reports `wcag/h32` (missing submit button) or `wcag/h71` (missing legend). At runtime the consumer fills the body via yielded children + `...attributes`, and the required structural child IS provided. FP.

This is the *same shape* as the multipass yield-only-branch heuristic in `form-submit-in-else.gts` / `multipass-yield-only-branch.gts` but for non-multipass templates. The yield-only-branch handling currently scopes to multipass branches; we need a non-multipass extension: when an element's body is *yield-only* (or yield + only static content that doesn't satisfy the rule), suppress the structural-required-child rule for that element.

**Fix paths to consider.**

1. **Generalize the yield-only-branch heuristic** to fire outside multipass too: detect that a `<form>`/`<fieldset>` body contains `{{yield}}` (possibly as the only non-whitespace child) and inject a synthetic placeholder child sufficient to satisfy the rule (e.g. `<button type='submit' style='display:none'>` for `wcag/h32`, `<legend></legend>` for `wcag/h71`).

2. **Per-rule suppression at the source level**: prepend an `<!-- [html-validate-disable-block wcag/h32] -->` directive when the element's body is yield-only. Less robust (rule-list grows over time) but localized.

Approach (1) is cleaner. Symmetric to the existing input-type injection at `blank.ts:644-648`.

**Test.** Add `examples/form-yield-only-no-multipass.gts` — `<form>{{yield}}</form>` with no `{{#if}}/{{else}}` — and assert no `wcag/h32` fires. Same shape for fieldset/legend.

---

## 🔴 Classic Ember addon components with `.hbs` templates aren't root-tag-resolved

**Affected targets:** ember-website (98 findings: `<EsCard>` from `ember-styleguide` used as list items); hds-design-system (25+ similar findings on internal addon list-item components like `<HdsAppSideNav.List.Item>`).

**Pattern.** Classic Ember addon components have `.hbs` templates and no JS-side `Signature['Element']` (no class form, no TOC `satisfies`). The plugin's existing root-tag resolution is JS-only — when no JS-side type info exists, the component is transparent-blanked and its children re-parent to the actual ancestor in the consuming template.

For `<EsCard>` (template: `<li class="card" ...attributes>{{yield}}</li>`), the runtime DOM is correct — `<li>` inside `<ul>` is legal. But the plugin sees `<ul><EsCard>...</EsCard></ul>` blanked to `<ul>...</ul>` and html-validate fires `element-permitted-content` on the children.

**Fix path.** Extend the existing splatted-root resolution (`getSplattedRootsForFile` in `lib/component-attrs.ts`, currently `.gts`-only) to also walk `.hbs` files. For a component reference resolved via Ember's lookup rules (kebab-cased name, addon `addon/templates/components/foo.hbs` or app `app/components/foo.hbs`), parse the root native element and feed its tag into `componentTagMap`.

**Substantial extension.** Has to handle:
- Component-name → template-path resolution (kebab-case, addon vs app, classic vs MU).
- Component templates may have non-trivial root structure (a `{{#if}}` wrapping multiple roots, or a `{{yield}}` wrapping the whole thing).
- Reading from the consuming project's `node_modules`.

May not fit in a single fix branch. If too invasive, land on `failing-test/fp-classic-addon-template-resolution` with a regression test that locks in the assertion.

**Test.** Add fixture under `test/glint-fixtures/` (or new `test/classic-addon-fixtures/`) with a fake `node_modules/<addon>/addon/templates/components/foo.hbs` containing `<li>{{yield}}</li>`, plus a consuming `.gts` that uses `<Foo>` inside `<ul>`. Assert `componentTagMap` resolves `Foo` → `li`.

---

## 🔴 Yielded curried components lose Glint root-tag resolution

**Affected targets:** hds-design-system (107 findings: `<option>` flagged as not permitted under `<div>`, all from `<HdsFormSelectBase as |C|><C.Options>...</C.Options></HdsFormSelectBase>` patterns); pending review for others.

**Pattern.** When a parent component yields a curried sub-component (`<C.Options>` block-param), Glint type information for the sub-component doesn't follow through. The plugin transparent-blanks `<C.Options>`, floating its children (`<option>`s) up to the wrapping `<div>` from the parent component instead of the runtime `<select>`.

```gts
<HdsFormSelectBase ... as |C|>
  <C.Options>
    <option value="all">Show all</option>
  </C.Options>
</HdsFormSelectBase>
```

**Fix path.** Glint's program-level type info knows that `C.Options` (yielded as a block-param via `Yields` in the Signature) resolves to a select-options-style sub-component. Need to chase block-param yields through `Signature['Blocks']` and feed the sub-component's `Element` into `componentTagMap`. Substantial — involves traversing block-param dataflow, not just direct component lookup.

**Test.** Fixture: a parent component yielding a curried `<C.Sub>` whose Signature['Element'] is a known native tag, used in a consumer that places content inside `<C.Sub>`. Assert no FP fires on the inner content's parent.

---

## 🔴 Component-arg-bound required attributes don't get DynamicValue placeholders

**Affected targets:** hds-design-system (39 findings: all `<iframe>` missing `title`, all from `<ShwFrame @label={{...}}>` where ShwFrame's template is `<iframe title={{@label}} ...>`); pending review for others.

**Pattern.** A component declares its template as `<NativeTag requiredAttr={{@arg}} ...>` and Glint resolves the component to the native tag. The required attribute IS present at runtime (bound to `@arg`), but the splatted-root literal-attribute extractor only handles literal values (`title='Static'`), not arg-bindings (`title={{@label}}`).

**Fix path.** Extend `getSplattedRootsForFile` (or its consumer) to also surface arg-bound attributes — emit a DynamicValue placeholder (whitespace-string) when the attribute value is `{{@arg}}`. The plugin already has the `processAttribute` → DynamicValue path for bare-mustache in consumer templates; this is the same idea applied to component-internal templates.

**Test.** Fixture component declares `<iframe title={{@label}} src={{@src}}>` with `Signature['Args'] = { label: string; src: string }`. Consumer uses `<MyFrame @label="x" @src="y" />`. Assert no `element-required-attributes` (`title`) fires.

---

## 🔴 Mysterious `<abbr>` ancestor resolution (Glint generic `HTMLElement` fallback?)

**Affected targets:** ember-power-select (1 finding); hds-design-system (8 findings: 8× `<div>` under `<abbr>` + 3× `<option>` under `<abbr>` + 1× `<abbr>` under `<ol>`).

**Pattern.** html-validate reports `<div>` is not permitted under `<abbr>`, but the source file contains no literal `<abbr>`. An ancestor component is being Glint-resolved to the `abbr` tag. The most likely cause: a component declares `Signature['Element']` as the generic `HTMLElement` (not a specific subclass like `HTMLDivElement`), and the plugin's `HTMLElement` → tag mapping falls through to something that lands on `abbr`.

Needs a scoped repro and inspection of `lib/glint.ts`'s element-class → tag mapping. May be a one-line fix (don't resolve `HTMLElement` to anything — leave the component in transparent-blanking territory) or may indicate a bigger gap.

**Test.** A fixture with a TOC declaring `Element: HTMLElement` (the generic). Validate. Assert no spurious ancestor-resolution finding fires.

---

## Stylistic / preset-policy review

Tracked separately in `STYLISTIC-FINDINGS.md` — these aren't FPs but are recommended-preset-default candidates.

---

(More entries will be appended as additional targets are triaged.)
