// Regression: a wrapper component that Glint resolves to 'transparent'
// (Element: HTMLElement bare) sits inside `<ul>`. The wrapper's
// `<template>` renders `<li>{{yield}}</li>` — that information is
// statically available in the file's splatted-root, but Glint's
// TS-only resolution (`Element: HTMLElement`) gives us nothing more
// specific than 'transparent'.
//
// A child that resolves to `<div>` placed inside the wrapper inside
// `<ul>` would, at runtime, become `<ul><li><div /></li></ul>` —
// legal. Our static blanker, however, transparent-blanks the wrapper,
// so `<div>` ends up directly under `<ul>` and
// `element-permitted-content` FP-fires.
//
// Real-world repro: large component libraries shipping list-item
// components declared as `Element: HTMLLIElement` but imported through
// barrels often surface as 'transparent' in downstream consumers when
// the type chain doesn't resolve cleanly across the barrel. Same FP
// shape regardless of why Glint returned 'transparent'.
import type { TemplateOnlyComponent } from '@ember/component/template-only';

interface TransparentWrapperSig {
  Blocks: { default: [] };
  Element: HTMLElement;  // bare generic → 'transparent' resolution
}

const TransparentWrapper: TemplateOnlyComponent<TransparentWrapperSig> =
  <template>
    <li class="x" ...attributes>{{yield}}</li>
  </template>;

interface ContentSig {
  Element: HTMLDivElement;
  Blocks: { default: [] };
}
const Content: TemplateOnlyComponent<ContentSig> = <template>
  <div ...attributes>{{yield}}</div>
</template>;

<template>
  <ul>
    <TransparentWrapper>
      <Content>placeholder</Content>
    </TransparentWrapper>
  </ul>
</template>
