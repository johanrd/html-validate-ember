// Consumer that uses `<OuterButton>` with `aria-label` set via the
// wrapper's args. Mirrors the real-world HDS pattern where
// `<HdsCopyButton>` wraps `<HdsButton>` which wraps `<HdsInteractive>`
// which renders `<a href={{@href}}>` or `<button>`.
//
// Without chain-attr collection, the consumer-side substitution puts
// `<a aria-label='...'>` (no href) into the blanked output, which
// fires `aria-label-misuse` (aria-label requires an interactive `<a>`,
// i.e. one with href).
//
// With chain-attr collection (this regression test asserts the
// behavior at the AST/map level), the substituted element carries
// `href` as a `DynamicValue` placeholder so html-validate sees the
// `<a>` as interactive and aria-label-misuse doesn't fire.
import OuterButton from './conditional-leaf-href-wrapper.gts';

<template>
  <OuterButton @href="/" @label="More info">
    Click me
  </OuterButton>
</template>
