// Reproduction for issue #37. html-validate treats `<svg>` as foreign
// content (`foreign: true` in its bundled element schema) and discards
// the body wholesale, so SVG-namespace children inside a literal
// `<svg>...</svg>` wrapper are never validated. But when the SVG
// fragment doesn't share an enclosing `<svg>` literal with its children
// in the same template — e.g., the fragment is the body of a
// `{{#if}}` while the wrapping `<svg>` lives in a parent component —
// every svg-namespace tag reaches html-validate in non-foreign context
// and trips `element-name` / `element-case`.
<template>
  {{#if @show}}
    <defs>
      <linearGradient id="g">
        <stop offset="0%" stop-color="red" />
        <stop offset="100%" stop-color="blue" />
      </linearGradient>
    </defs>
    <circle cx="50" cy="50" r="40" fill="url(#g)" />
  {{/if}}
</template>
