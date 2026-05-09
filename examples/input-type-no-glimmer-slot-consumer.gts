// Reproduces the no-implicit-input-type cluster on substituted void
// components without Glimmer-attr slots. Consumer writes only non-
// Glimmer attrs (`aria-label="…"`), so source-side `tryInjectInputType`
// has no candidate range and bails. Without hook-time fallback, the
// substituted `<input>` reaches html-validate without `type`, FP-firing
// `no-implicit-input-type`.
import MyCheckbox from '../test/glint-fixtures/input-type-no-glimmer-slot-leaf.gts';

<template>
  <MyCheckbox aria-label="Unchecked checkbox" />
</template>
