// Cross-package barrel import — consumer pulls `<ListLink>` through a
// package's barrel (`list-link-addon/components`). The import-based
// fallback in `lib/outer-wrapper-resolver.ts` walks the consumer's
// import statement, resolves the package path, follows the barrel
// re-export, and reads the resolved `.gts` to find the outer
// wrapper (`<li>` via ListItem).
//
// Mirrors the design-system component-package pattern that Glint's
// TS symbol resolution can fail to follow when the package's
// compiled declarations don't expose the source typing cleanly.
import { ListLink } from 'list-link-addon/components';

<template>
  <ul>
    <ListLink>One</ListLink>
    <ListLink>Two</ListLink>
  </ul>
</template>
