# ember-a11y-testing — triage

Pinned at `c79cfb8ba87e31c2c03e8401fd85cd5334a8c86d`. 4 files validated, 8 findings.

The demo app contains *deliberate* a11y violations (`violations.gts`, `ignored-image-alt.gts`) — these are reference fixtures for the addon's accessibility testing. Triage distinguishes "rule fired correctly on intentional fixture" from genuine plugin gaps.

| # | File | Line | Rule | Verdict | Notes |
|---|------|------|------|---------|-------|
| 1 | `demo-app/templates/ignored-image-alt.gts` | 6 | `wcag/h37` (`<img>` missing `alt`) | **intentional** | Fixture filename literally says `ignored-image-alt`; `{{! template-lint-disable require-valid-alt-text }}` directive present. By-design. |
| 2 | `demo-app/templates/ignored-image-alt.gts` | 6 | `attribute-allowed-values` (`src=""`) | **intentional** | Same fixture file. By-design. |
| 3 | `demo-app/templates/violations.gts` | 57 | `element-permitted-content` (`<button>` not permitted under `<ul>`) | **FP-plugin** | `<button>` is inside `<ViolationsGridItem>` which is a TOC declared with `satisfies TOC<{Element: HTMLLIElement, ...}>`. At runtime button is inside `<li>` (legal). Plugin's Glint resolver isn't picking up `Element` from `satisfies TOC<…>` form (works for `class extends Component<Sig>` per `test/glint-fixtures/typed-button.gts`). |
| 4 | `demo-app/templates/violations.gts` | 57 | `text-content` (`<button>` empty) | **intentional** | The fixture is `<button></button>` — labelled in the page header as "Button without title". By-design. |
| 5 | `demo-app/templates/violations.gts` | 70 | `element-permitted-content` (`<input>` under `<ul>`) | **FP-plugin** | Same TOC-resolution gap as #3. |
| 6 | `demo-app/templates/violations.gts` | 103 | `element-permitted-content` (`<code>` under `<ul>`) | **FP-plugin** | Same. |
| 7 | `demo-app/templates/violations.gts` | 114 | `element-permitted-content` (`<img>` under `<ul>`) | **FP-plugin** | Same. |
| 8 | `demo-app/templates/violations.gts` | 114 | `wcag/h37` (`<img>` missing `alt`) | **intentional** | Section header: "&lt;img&gt; Tags without alt attributes". By-design. |

## Summary

- **TP-intentional**: 4 (deliberate fixtures for the addon's own testing)
- **FP-plugin**: 4 (all from one root cause — TOC `satisfies` form's `Element` declaration isn't being honored)
- **TP**: 0 (genuine bugs)
- **FP-rule**: 0

No issue to file. The intentional violations are by design (and the addon catches them too — html-validate's results agree with the addon's purpose). The FP-plugin pattern needs fixing on our side.

## Plugin work this surfaces

**New FP pattern**: TOC components declared via `satisfies TOC<{Element: ...}>` aren't being resolved to their declared element type by the Glint integration.

```ts
const ViolationsGridItem = <template>
  <li class="..." ...attributes>{{yield}}</li>
</template> satisfies TOC<{
  Element: HTMLLIElement;
  Args: { title: string };
  Blocks: { default: [] };
}>;
```

This should be Glint-resolvable to `li` the same way `class extends Component<Sig>` is. The `lib/glint.ts` resolver currently appears to handle the class form (per `test/glint-fixtures/typed-button.gts`) but not the satisfies-TOC form.

Will be added to FP-FIX-REPORT and a `fix/fp-toc-element-resolution` branch.
