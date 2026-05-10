// Consumer importing a polymorphic-tag component from a v2-addon
// that ships ONLY compiled `.js + .d.ts` (no `.gts` source).
// Mirrors the standard v2-addon shipping mode per the v2-addon
// spec — most addons publish this way (HDS is the exception with
// its `src/*.gts` alongside).
//
// Regression test: the chain trace must work for v2-spec-standard
// shipping. The polymorphic resolver:
//   1. TS resolves `<PolyListItem>` to `declarations/poly-list-item.d.ts`
//   2. resolveGtsPathForPolymorphic maps `.d.ts` → `dist/poly-list-item.js`
//      (the first try `declarations/X.d.ts → src/X.gts` returns null)
//   3. extractTemplateContent uses TS to walk `.js` AST and
//      extract the first arg of `precompileTemplate(...)` /
//      `template(...)`
//   4. The chain trace recurses through the .js imports and
//      surfaces the literal `@tag="li"` that wraps PolyText.
import PolyListItem from 'polymorphic-addon-js-only/components/poly-list-item';

<template>
  <ul>
    <PolyListItem>list content</PolyListItem>
  </ul>
</template>
