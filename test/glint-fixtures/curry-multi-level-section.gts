// Mid-level wrapper: yields a hash containing a curried inner. Used
// as a nested-dotted target — the consumer reaches it via
// `<Outer as |O|><O.Section as |S|><S.Title>` (two dotted hops).
import { hash } from '@ember/helper';

import CurryInner from './curry-component-yield-hash-inner.gts';

<template>
  <div class="curry-section" ...attributes>
    {{yield (hash Title=(component CurryInner size="300"))}}
  </div>
</template>
