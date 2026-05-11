// Consumer invokes the wrapper with no `@tag` — wrapper's getter
// falls back to its 'div' default and forwards `@tag="div"` to the
// inner. Inner's `(element this.componentTag)` resolves to <div>.
// Regression guard: without `{{this.X}}` passthrough in
// resolvePascalRecursion, the inner would see no consumer @tag,
// inner's own getter default ('span') would win, and the wrapper
// would resolve to <span>.
import ThisPropWrapper from './this-prop-passthrough-wrapper-leaf.gts';

<template>
  <ThisPropWrapper>content</ThisPropWrapper>
</template>
