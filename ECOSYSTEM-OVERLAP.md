# Ecosystem overlap: Ember template linting

This document maps each `template-*` rule in `eslint-plugin-ember` (135 rules) against equivalents in `html-validate` (consumed via `html-validate-ember`) and `html-eslint`, so a project can decide where each check should live.

## Sources

- **eslint-plugin-ember** v13.2.0 — `/Users/johanrd/fremby/eslint-plugin-ember/lib/rules/` (135 `template-*` rules + 97 JS/TS rules; the JS/TS rules are out of scope here).
- **html-validate** master — `/Users/johanrd/Downloads/html-validate-master/src/rules/` (~86 active rules + 7 under `wcag/`).
- **html-eslint** master — `/Users/johanrd/Downloads/html-eslint-main/packages/eslint-plugin/lib/rules/` (68 rules in the core plugin; the React/Svelte/Angular adapters at `packages/eslint-plugin-{react,svelte,angular-template}/` carry only 7 of these).

## Verdict legend

- **`html-validate`** — already covered by `html-validate-ember`; the `template-*` rule can be turned off without losing the check.
- **`html-validate (partial)`** — html-validate covers part of the intent; review the specific assertions before disabling.
- **`html-validate gap`** — HTML-correctness check with no current html-validate equivalent. Candidate for a custom html-validate plugin rule (lower-cost than an html-eslint Ember adapter).
- **`prettier-plugin-ember`** — pure formatting; arguably belongs in the formatter.
- **`stays`** — Ember-runtime, Glimmer-AST shape, or Ember-style; not portable to a generic HTML linter.

The **html-eslint** column lists the closest rule in `@html-eslint/eslint-plugin`'s **core** set, with `†` marking the seven rules that are also lifted into the framework adapters (`class-spacing`, `no-duplicate-class`, `no-ineffective-attrs`, `no-invalid-attr-value`, `no-obsolete-attrs`, `no-obsolete-tags`, `use-baseline`). All other html-eslint rules are core-plugin-only and would *not* automatically become available even if a hypothetical `@html-eslint/eslint-plugin-ember` were built on the same adapter pattern as the existing framework plugins.

## Summary

| Category | Count | What to do |
|---|---:|---|
| Stays in `eslint-plugin-ember` (Ember runtime / Glimmer-semantic / deprecation / Ember style) | 80 | Keep. Cannot be ported. |
| Already covered by `html-validate` (offload candidates) | 18 | Disable in `eslint-plugin-ember`; rely on `html-validate-ember`. |
| Partial overlap with `html-validate` | 14 | Audit individually; some can be dropped, some need to stay. |
| No html-validate equivalent (custom-rule candidates) | 14 | Keep for now; consider a custom html-validate plugin rule. |
| Belongs to `prettier-plugin-ember` (pure formatting) | 9 | Already covered by Prettier; keep ESLint rule only if not running Prettier. |

Total: 135.

---

## Already covered by html-validate (offload candidates)

These reproduce checks that `html-validate-ember` already runs natively. Disable them in `eslint-plugin-ember` if you have html-validate-ember in your pipeline.

| Rule | Description | html-validate | html-eslint (core) |
|---|---|---|---|
| `template-no-abstract-roles` | disallow abstract ARIA roles | `no-abstract-role` | `no-abstract-roles` |
| `template-no-aria-hidden-body` | disallow aria-hidden on body element | `aria-hidden-body` | `no-aria-hidden-body` |
| `template-no-duplicate-attributes` | disallow duplicate attribute names | `no-dup-attr` | `no-duplicate-attrs` |
| `template-no-duplicate-id` | disallow duplicate id attributes | `no-dup-id` | `no-duplicate-id` |
| `template-no-duplicate-landmark-elements` | disallow duplicate landmark elements without unique labels | `unique-landmark` | — |
| `template-no-empty-headings` | disallow empty heading elements | `empty-heading` | `no-empty-headings` |
| `template-no-heading-inside-button` | disallow heading elements inside button elements | `element-permitted-content` | `no-heading-inside-button` |
| `template-no-inline-styles` | disallow inline styles | `no-inline-style` | `no-inline-styles` |
| `template-no-jsx-attributes` | disallow JSX-style camelCase attributes | `attr-case` | `lowercase` |
| `template-no-obsolete-elements` | disallow obsolete HTML elements | `deprecated`, `element-name` | `no-obsolete-tags` † |
| `template-no-quoteless-attributes` | require quotes on all attribute values | `attr-quotes` | `quotes` |
| `template-no-redundant-role` | disallow redundant role attributes | `no-redundant-role` | `no-redundant-role` |
| `template-require-button-type` | require button elements to have a valid type attribute | `no-implicit-button-type` | `require-button-type` |
| `template-require-iframe-src-attribute` | require iframe elements to have src attribute | `element-required-attributes` (configurable) | `require-attrs` |
| `template-require-iframe-title` | require iframe elements to have a title attribute | `element-required-attributes` (configurable) | `require-frame-title` |
| `template-require-input-label` | require label for form input elements | `input-missing-label` | `require-input-label` |
| `template-require-input-type` | require input elements to have a valid type attribute | `no-implicit-input-type` | — |
| `template-require-valid-alt-text` | require valid alt text for images and other elements | `wcag/h37` | `require-img-alt` |

---

## Partial overlap with html-validate

These have some coverage in html-validate but the assertions don't fully line up. Audit each one in your codebase before deciding to disable the ESLint rule.

| Rule | Description | html-validate (partial) | html-eslint (core) |
|---|---|---|---|
| `template-link-href-attributes` | require href attribute on link elements | `element-required-attributes` (configurable) | `require-attrs` |
| `template-no-aria-unsupported-elements` | disallow ARIA roles, states, and properties on elements that do not support them | `aria-label-misuse` (label only) | — |
| `template-no-invalid-aria-attributes` | disallow invalid aria-* attributes | `attr-pattern`, role-related rules | — |
| `template-no-invalid-link-text` | disallow invalid or uninformative link text content | `wcag/h30` (link text purpose) | — |
| `template-no-invalid-link-title` | disallow invalid title attributes on link elements | `wcag/h67` | — |
| `template-no-invalid-role` | disallow invalid ARIA roles | role validation in element rules | `no-invalid-role` |
| `template-no-nested-interactive` | disallow nested interactive elements | `element-permitted-content` (some cases) | `no-nested-interactive` |
| `template-no-scope-outside-table-headings` | disallow scope attribute outside th elements | `wcag/h63` | — |
| `template-no-unsupported-role-attributes` | disallow ARIA attributes that are not supported by the element role | role-related rules | — |
| `template-require-context-role` | require ARIA roles to be used in appropriate context | `element-required-ancestor` | — |
| `template-require-mandatory-role-attributes` | require mandatory ARIA attributes for ARIA roles | `element-required-attributes` | — |
| `template-require-presentational-children` | require presentational elements to only contain presentational children | `element-permitted-content` | — |
| `template-require-valid-form-groups` | require grouped form controls to have fieldset/legend or WAI-ARIA group labeling | `wcag/h71` | — |
| `template-table-groups` | require table elements to use table grouping elements | `prefer-tbody` (only `<tbody>`) | — |

---

## No html-validate equivalent (custom-rule candidates)

These are HTML-correctness or a11y checks with no equivalent in html-validate today. Each is a candidate for a small custom rule in a future `html-validate-ember`-bundled plugin (much cheaper than building an html-eslint Ember adapter; reuses the same parser pipeline).

| Rule | Description | html-eslint (core) |
|---|---|---|
| `template-no-accesskey-attribute` | disallow accesskey attribute | `no-accesskey-attrs` |
| `template-no-autofocus-attribute` | disallow autofocus attribute | `no-restricted-attrs` (configurable) |
| `template-no-invalid-interactive` | disallow non-interactive elements with interactive handlers | — |
| `template-no-invalid-meta` | disallow invalid meta tags | `no-restricted-attr-values` (configurable) |
| `template-no-nested-landmark` | disallow nested landmark elements | — |
| `template-no-pointer-down-event-binding` | disallow pointer down event bindings | — |
| `template-no-positive-tabindex` | disallow positive tabindex values | `no-positive-tabindex` |
| `template-require-form-method` | require form method attribute | `require-form-method` |
| `template-no-whitespace-for-layout` | disallow using whitespace for layout purposes | `no-whitespace-only-children` |
| `template-no-whitespace-within-word` | disallow excess whitespace within words (e.g. "W e l c o m e") | — |
| `template-link-rel-noopener` | require rel="noopener noreferrer" on links with target="_blank" | `no-target-blank` |
| `template-require-aria-activedescendant-tabindex` | require non-interactive elements with aria-activedescendant to have tabindex | — |
| `template-require-lang-attribute` | require lang attribute on html element | `require-lang` |
| `template-require-media-caption` | require captions for audio and video elements | — |

---

## Belongs to prettier-plugin-ember (formatting)

If your project runs Prettier on templates, these are redundant. Keep only if you don't.

| Rule | Description |
|---|---|
| `template-attribute-indentation` | enforce proper indentation of attributes and arguments in multi-line templates |
| `template-attribute-order` | enforce consistent ordering of attributes in template elements |
| `template-block-indentation` | enforce consistent indentation for block statements and their children |
| `template-eol-last` | require or disallow newline at the end of template files |
| `template-linebreak-style` | enforce consistent linebreaks in templates |
| `template-no-multiple-empty-lines` | disallow multiple consecutive empty lines in templates |
| `template-no-trailing-spaces` | disallow trailing whitespace at the end of lines in templates |
| `template-quotes` | enforce consistent quote style in templates |
| `template-self-closing-void-elements` | require self-closing on void elements |

`template-self-closing-void-elements` also overlaps with html-validate's `void-style` (which `html-validate-ember:gts-recommended` already configures to `selfclosing`).

---

## Stays in eslint-plugin-ember

Ember-runtime knowledge, Glimmer-AST shape, or Ember-style conventions that a generic HTML linter cannot model.

### Built-in components and helpers

| Rule | Description |
|---|---|
| `template-builtin-component-arguments` | disallow setting certain attributes on builtin components |
| `template-no-builtin-form-components` | disallow usage of built-in form components |
| `template-no-input-block` | disallow block usage of {{input}} helper |
| `template-no-input-tagname` | disallow tagName attribute on {{input}} helper |
| `template-no-link-to-positional-params` | disallow positional params in LinkTo component |
| `template-no-link-to-tagname` | disallow tagName attribute on LinkTo component |
| `template-no-inline-linkto` | disallow inline form of LinkTo component |
| `template-no-page-title-component` | disallow usage of ember-page-title component |
| `template-no-unknown-arguments-for-builtin-components` | disallow unknown arguments for built-in components |
| `template-no-restricted-invocations` | disallow certain components, helpers or modifiers from being used |
| `template-no-forbidden-elements` | disallow specific HTML elements (Ember-specific blocklist convention) |
| `template-no-unnecessary-component-helper` | disallow unnecessary component helper |
| `template-no-redundant-fn` | disallow unnecessary usage of (fn) helper |

### Component invocation conventions

| Rule | Description |
|---|---|
| `template-no-curly-component-invocation` | disallow curly component invocation, use angle bracket syntax instead |
| `template-no-index-component-invocation` | disallow index component invocations |
| `template-no-arguments-for-html-elements` | disallow @arguments on HTML elements |
| `template-no-block-params-for-html-elements` | disallow block params on HTML elements |
| `template-no-capital-arguments` | disallow capital arguments (use lowercase @arg instead of @Arg) |
| `template-no-args-paths` | disallow args.foo paths in templates, use @foo instead |
| `template-no-attrs-in-components` | disallow attrs in component templates |
| `template-no-positional-data-test-selectors` | disallow positional data-test-* params in curly invocations |
| `template-no-valueless-arguments` | disallow valueless named arguments |
| `template-no-class-bindings` | disallow passing classBinding or classNameBindings as arguments |

### Reactivity / `this` semantics

| Rule | Description |
|---|---|
| `template-no-implicit-this` | require explicit `this` in property access |
| `template-no-this-in-template-only-components` | disallow this in template-only components |
| `template-no-unavailable-this` | disallow `this` in templates not inside class/function |
| `template-no-chained-this` | disallow redundant `this.this` in templates |

### `@arg` / `...attributes` semantics

| Rule | Description |
|---|---|
| `template-no-nested-splattributes` | disallow nested ...attributes usage |
| `template-no-splattributes-with-class` | disallow splattributes with class attribute |
| `template-splat-attributes-only` | disallow ...spread other than ...attributes |
| `template-require-splattributes` | require splattributes usage in component templates |

### Modifier API and event handling

| Rule | Description |
|---|---|
| `template-modifier-name-case` | require dasherized names for modifiers |
| `template-simple-modifiers` | require simple modifier syntax |
| `template-no-action-modifiers` | disallow usage of {{action}} modifiers |
| `template-no-action-on-submit-button` | disallow action attribute on submit buttons |
| `template-no-element-event-actions` | disallow element event actions (use {{on}} modifier instead) |
| `template-no-inline-event-handlers` | disallow DOM event handler attributes |
| `template-no-passed-in-event-handlers` | disallow passing event handlers directly as component arguments |
| `template-no-at-ember-render-modifiers` | disallow usage of @ember/render-modifiers |

### Ember runtime and routing

| Rule | Description |
|---|---|
| `template-no-outlet-outside-routes` | disallow {{outlet}} outside of route templates |
| `template-no-model-argument-in-route-templates` | disallow @model argument in route templates |
| `template-no-array-prototype-extensions` | disallow usage of Ember Array prototype extensions |
| `template-no-obscure-array-access` | disallow obscure array access patterns like `objectPath.@each.property` |
| `template-no-potential-path-strings` | disallow potential path strings in attribute values |

### Block params, yield, and templates

| Rule | Description |
|---|---|
| `template-no-shadowed-elements` | disallow ambiguity with block param names shadowing HTML elements |
| `template-no-unused-block-params` | disallow unused block parameters in templates |
| `template-no-bare-yield` | disallow templates whose only meaningful content is a bare {{yield}} |
| `template-no-yield-block-params-to-else-inverse` | disallow yielding block params to else or inverse block |
| `template-no-yield-only` | disallow components that only yield |
| `template-no-yield-to-default` | disallow yield to default block |
| `template-no-only-default-slot` | disallow using only the default slot |
| `template-require-each-key` | require key attribute in {{#each}} loops |
| `template-require-has-block-helper` | require (has-block) helper usage instead of hasBlock property |
| `template-require-valid-named-block-naming-format` | require valid named block naming format |
| `template-require-strict-mode` | require templates to be in strict mode |
| `template-no-let-reference` | disallow referencing let variables in `<template>` |

### Glimmer-syntactic style

| Rule | Description |
|---|---|
| `template-no-debugger` | disallow {{debugger}} in templates |
| `template-no-log` | disallow {{log}} in templates |
| `template-no-html-comments` | disallow HTML comments in templates |
| `template-no-triple-curlies` | disallow usage of triple curly brackets (unescaped variables) |
| `template-no-unbalanced-curlies` | disallow unbalanced mustache curlies |
| `template-no-unnecessary-curly-parens` | disallow unnecessary parentheses enclosing statements in curlies |
| `template-no-unnecessary-curly-strings` | disallow unnecessary curly braces in string interpolations |
| `template-no-dynamic-subexpression-invocations` | disallow dynamic subexpression invocations |
| `template-no-unnecessary-concat` | disallow unnecessary string concatenation |
| `template-style-concatenation` | disallow string concatenation in inline styles |
| `template-no-negated-condition` | disallow negated conditions in if/unless |
| `template-simple-unless` | require simple conditions in unless blocks |
| `template-template-length` | enforce template size constraints |
| `template-sort-invocations` | require sorted attributes and modifiers (Ember-specific argument-vs-attribute ordering) |

### i18n

| Rule | Description |
|---|---|
| `template-no-bare-strings` | disallow bare strings in templates (require translation/localization) |

### Deprecated Ember helpers / components

| Rule | Description |
|---|---|
| `template-no-deprecated` | disallow using deprecated Glimmer components, helpers, and modifiers |
| `template-deprecated-inline-view-helper` | disallow inline {{view}} helper |
| `template-deprecated-render-helper` | disallow {{render}} helper |
| `template-no-action` | disallow {{action}} helper |
| `template-no-route-action` | disallow usage of route-action helper |
| `template-no-mut-helper` | disallow usage of (mut) helper |
| `template-no-extra-mut-helper-argument` | disallow passing more than one argument to the mut helper |
| `template-no-with` | disallow {{with}} helper |
| `template-no-unbound` | disallow {{unbound}} helper |

---

## How this informs `@html-eslint/eslint-plugin-ember`

If a hypothetical Ember adapter for `html-eslint` were built on the same pattern as the React/Svelte/Angular adapters, it would inherit only the seven core rules marked `†` above:

| html-eslint rule | html-validate equivalent | Net new value over `html-validate-ember`? |
|---|---|---|
| `class-spacing` | none (formatting) | marginal — `prettier-plugin-ember` already covers |
| `no-duplicate-class[name]` | `no-dup-class` | none |
| `no-ineffective-attrs` | `attribute-misuse` | none / marginal |
| `no-invalid-attr-value` | `attribute-allowed-values` | none |
| `no-obsolete-attrs` | `no-deprecated-attr` | none |
| `no-obsolete-tags` | `deprecated`, `element-name` | none |
| `use-baseline` | none | yes — Web Platform Baseline check |

Cost: a custom ESLint parser wrapping `@glimmer/syntax`, `ElementAdapter` / `AttributeAdapter` / `AttributeValueAdapter` implementations, and translation glue for splattributes / mustaches / block helpers / named arguments. The single rule with non-overlapping value (`use-baseline`) can ship as a small custom html-validate rule against `web-features` data, with no parser plumbing and no second adapter to maintain.
