// Reproduces the `attribute-allowed-values` FP on substituted
// void components whose chain-attr `type` is the DynamicValue
// placeholder (mustache-bound at runtime). Consumer has only
// non-Glimmer attrs, so source-side `tryInjectInputType` falls
// through to the hook-time `setAttribute` path. Pre-fix, the
// hook injected the placeholder as a string literal (`type='   '`)
// — `attribute-allowed-values` then fired with "invalid value
// '   '". Post-fix, the placeholder is rejected from
// `isLiteralSafeForAttr`, the hook injects DynamicValue, and the
// rule accepts.
import MyDynamicInput from '../test/glint-fixtures/input-type-dynamic-leaf.gts';

<template>
  <MyDynamicInput aria-label="example" />
</template>
