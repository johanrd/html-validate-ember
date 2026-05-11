// Outer wrapper: yields a hash mapping `Section` to the Section
// wrapper (which itself yields a hash with `Title`).
// Mirrors HdsForm yielding `Section=HdsFormSection` (where
// HdsFormSection.Title yields the curried HdsFormHeaderTitle).
import { hash } from '@ember/helper';

import Section from './curry-multi-level-section.gts';

<template>
  <div class="curry-outer" ...attributes>
    {{yield (hash Section=Section)}}
  </div>
</template>
