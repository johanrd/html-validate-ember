// MathML companion to `svg-foreign-content.gts`. Same shape: an
// mathml-namespace fragment lives inside a `{{#if}}` while the wrapping
// `<math>` lives in a parent component. Without the canonical-case
// allowlist, every mathml tag would trip `element-name`.
<template>
  {{#if @show}}
    <mrow>
      <msup>
        <mi>x</mi>
        <mn>2</mn>
      </msup>
      <mo>+</mo>
      <mi>y</mi>
    </mrow>
  {{/if}}
</template>
