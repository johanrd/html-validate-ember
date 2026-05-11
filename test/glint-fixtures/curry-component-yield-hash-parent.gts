// Mid-level parent: yields a Section component plus a curried inner
// `(component CurryInner size="300")` — mirrors how
// HdsFormSectionHeader yields `Title=(component HdsFormHeaderTitle …)`.
// In the consumer this is invoked DOTTED (`<P.Section>` /
// `<P.Section.Title>`) so the binder lookup traverses TWO levels.
import { hash } from '@ember/helper';

import CurryInner from './curry-component-yield-hash-inner.gts';

<template>
  <div class="curry-parent" ...attributes>
    {{yield (hash Title=(component CurryInner size="300"))}}
  </div>
</template>
