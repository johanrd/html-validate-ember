// Consumer importing a polymorphic-tag component from a v2-addon
// package whose TS resolution goes through `.d.ts` (not source
// `.gts`). The chain trace via `resolveGtsPathForPolymorphic`
// should still resolve `<PolyListItem>` to `<li>` (because the
// addon publishes `.gts` source alongside `.d.ts`).
//
// Regression test for the leaf-fallback over-resolution issue:
// the leaf-fallback uses the narrower `resolveGtsPath` (no .d.ts
// → .gts mapping) so cross-package non-polymorphic components
// don't get re-tagged via splatted-root scans (which surfaced 397
// new `element-permitted-content` FPs on HDS in an earlier
// version). The polymorphic chain uses
// `resolveGtsPathForPolymorphic` and only acts on components
// whose template uses `(element ...)`.
import PolyListItem from 'polymorphic-addon/components/poly-list-item';

<template>
  <ul>
    <PolyListItem>list content</PolyListItem>
  </ul>
</template>
