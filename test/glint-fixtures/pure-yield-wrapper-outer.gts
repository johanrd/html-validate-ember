// Outer component: wraps content in the pure-yield Inner. Mirrors
// HdsDropdown's `<HdsPopoverPrimitive as |PP|><div>...{{yield (hash …)}}...</div></HdsPopoverPrimitive>`
// shape. The OUTER element of this template is `<PureYieldInner>` —
// which is a pure-yielder. The real "rendered DOM outer" is the
// `<ul>` inside, which contains the yielded children.
import PureYieldInner from './pure-yield-wrapper-inner.gts';

<template>
  <PureYieldInner as |PP|>
    <ul class="real-outer" ...attributes>{{yield}}</ul>
  </PureYieldInner>
</template>
