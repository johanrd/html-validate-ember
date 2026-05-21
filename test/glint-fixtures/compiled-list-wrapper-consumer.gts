// Mirrors HDS's exact shape: a component imported from a COMPILED,
// published package barrel (`list-link-addon-js/components` →
// `dist/components.js` re-exporting compiled `dist/components/*.js`).
//
// `<ListLink>` declares `Element: HTMLAnchorElement`, but its compiled
// template wraps the `<a>` inside `<ListItem>` (→ `<li>`). The
// structural root is `<li>`, so `<ul><ListLink></ul>` renders valid
// `<ul><li><a>…</a></li></ul>`. element-permitted-content must NOT
// fire on `<a>`-under-`<ul>`.
//
// Source-based resolution already handles this (cross-package-barrel-
// consumer); this fixture pins the COMPILED-.js case, where recursing
// into the nested `<ListItem>` from a `precompileTemplate(...)` string
// must still reach `<li>` rather than falling back to the splatted
// `Signature['Element']` `<a>` (the FP that floods HDS).
import { ListItem, ListLink } from 'list-link-addon-js/components';

<template>
  <ul>
    <ListItem>direct item</ListItem>
    <ListLink>Home</ListLink>
  </ul>
</template>
