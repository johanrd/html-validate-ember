// Cross-package polymorphic-tag resolution: the canonical resolver must
// follow a v2 addon's .d.ts → .gts companion AND walk the
// `{{#if (eq this.componentTag "div")}} … {{else}} (element …) {{/if}}`
// + class-getter chain with consumer @tag="li" to resolve <li>.
//
// Mirrors the pattern found in HDS card/container: a barrel .d.ts barrel
// re-exports the component class; the runtime template lives in src/.
import { PolymorphicCard } from 'polymorphic-tag-addon/components';

<template>
  <ul>
    <PolymorphicCard @tag="li">item</PolymorphicCard>
  </ul>
</template>
