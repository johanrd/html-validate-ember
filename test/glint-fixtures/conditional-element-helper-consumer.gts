// Mirrors HDS card showcase: consumer passes `@tag="li"` to the
// HdsCardContainer-shape leaf. Runtime renders `<li>`; the resolver
// must walk the conditional + class-getter + `(element)` helper to
// see that.
import ConditionalElementHelper from './conditional-element-helper-leaf.gts';

<template>
  <ul>
    <ConditionalElementHelper @tag="li">item</ConditionalElementHelper>
  </ul>
</template>
