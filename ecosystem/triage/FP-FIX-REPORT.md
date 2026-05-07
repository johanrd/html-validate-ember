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

## Stylistic / preset-policy review

Tracked separately in `STYLISTIC-FINDINGS.md` — these aren't FPs but are recommended-preset-default candidates.

---

(More entries will be appended as additional targets are triaged.)
