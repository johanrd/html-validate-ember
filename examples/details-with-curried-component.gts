// Mirrors the proapi-webapp `punch-card.gts` shape: a recursive
// component (`CalculationDetails`) renders `<details><summary>...
// </summary>{{yield-or-each <CalculationDetails/>}}</details>` —
// recursive use of itself inside its own template.
//
// FP: when the consumer invokes `<CalculationDetails ... />` self-
// closingly, the blanker substitutes it to `<details>...</details>`
// (paired tags around empty body). html-validate's `element-
// required-content` rule fires on the substituted `<details>`
// because it doesn't see the `<summary>` that the addon's template
// renders inside.
//
// At runtime the rendered DOM IS valid: `<details><summary>...
// </summary>...</details>`. The FP comes from blanker-side static
// analysis losing visibility of the addon's structural children.
import type { TemplateOnlyComponent } from '@ember/component/template-only';

interface DetailsLikeSig {
  Args: { label?: string };
  Element: HTMLDetailsElement;
}
const DetailsLike: TemplateOnlyComponent<DetailsLikeSig> = <template>
  <details ...attributes>
    <summary>{{@label}}</summary>
    placeholder body
  </details>
</template>;

<template>
  <details>
    <summary>top-level</summary>
    <DetailsLike @label="nested 1" />
    <DetailsLike @label="nested 2" />
  </details>
</template>
