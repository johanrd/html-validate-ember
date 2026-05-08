// Consumer that uses TypedFrame self-closingly. End-to-end check: the
// blanker substitutes <TypedFrame /> to <iframe>, the splatted-root
// attribute extractor (lib/component-attrs.ts) records `title` and
// `src` as DynamicValue placeholders (because they're arg-bound in
// the addon's template), and `substituteSelfClosingComponent` embeds
// them in the rewritten output — so html-validate's
// `element-required-attributes` doesn't FP-fire on the substituted
// <iframe>.
import TypedFrame from '../test/glint-fixtures/typed-iframe.gts';

<template>
  <TypedFrame @label="Demo" @src="/demo" />
</template>
