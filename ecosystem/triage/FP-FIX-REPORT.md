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

(More entries will be appended as additional targets are triaged.)
