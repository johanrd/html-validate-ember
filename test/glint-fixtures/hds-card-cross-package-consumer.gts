// Mirrors HDS's card showcase tag.gts:
//   import { HdsCardContainer } from '@hashicorp/design-system-components/components';
//   <ul><HdsCardContainer @tag="li">…</HdsCardContainer></ul>
//
// Cross-package barrel + `.d.ts` for type-resolution. The runtime
// template lives in `src/components/card/container.gts`. The canonical
// resolver must follow the .d.ts → .gts companion AND walk the
// `{{#if (eq this.componentTag "div")}} … {{else}} (element …) {{/if}}`
// + class-getter chain with consumer @tag="li" to resolve <li>.
import { HdsCardContainer } from 'hds-card-addon/components';

<template>
  <ul>
    <HdsCardContainer @tag="li">item</HdsCardContainer>
  </ul>
</template>
