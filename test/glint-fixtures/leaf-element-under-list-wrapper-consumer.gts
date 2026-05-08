// Consumer for the leaf-vs-wrapper FP fixture. Imports `<ListLink>`
// from a separate file (mirroring real-world cross-file usage).
//
// Pattern: `<ListLink>` declares `Element: HTMLAnchorElement`. Its
// template wraps the `<a>` inside `<ListItem>` (which renders `<li>`).
// At runtime the consumer's `<ul>` contains `<li><a>...</a></li>` —
// legal. Glint's leaf-type resolution gives us `<a>`; the outer-
// wrapper resolver should walk the template chain (ListLink →
// ListItem → `<li>`) and prefer `<li>` for the consumer's
// substitution.
import ListLink from './leaf-element-list-link.gts';

<template>
  <ul>
    <ListLink>One</ListLink>
    <ListLink>Two</ListLink>
  </ul>
</template>
