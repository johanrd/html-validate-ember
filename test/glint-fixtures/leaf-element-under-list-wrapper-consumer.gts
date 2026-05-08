// Documents a deeper wrapper-vs-leaf FP class my template-root
// fallback does NOT solve.
//
// Pattern (real-world: design-system list-link components):
//
//   `<XListLink>` declares `Element: HTMLAnchorElement`.
//   Its template wraps the anchor inside a list-item:
//     <template>
//       <XListItem>
//         <a ...attributes>{{yield}}</a>
//       </XListItem>
//     </template>
//
// Consumer:
//   <ul>
//     <XListLink>...</XListLink>
//     <XListLink>...</XListLink>
//   </ul>
//
// At runtime: <ul><li><a>…</a></li><li><a>…</a></li></ul> (legal).
// Our static analysis: Glint says <XListLink>.element is
// HTMLAnchorElement → 'a'. We substitute consumer's <XListLink> to
// <a>, so html-validate sees <ul><a></a><a></a></ul> → fires
// `element-permitted-content` on <a>-under-<ul>.
//
// What we'd need to FIX this:
//   1) Walk the component's template, find the OUTERMOST native
//      ancestor (here `<XListItem>` → recurse → `<li>`), use that as
//      the substitution tag instead of the leaf Element type.
//   2) OR detect when a leaf-style Element (a/button) is placed under
//      a parent that requires a specific child (ul/ol → li, table →
//      tr) and refuse the substitution.
//
// (1) needs recursive cross-file template walking. (2) is a heuristic
// that may over- or under-suppress.
//
// Marked `.fails(...)` in `test/glint.test.ts` so when this resolution
// improves, vitest signals "remove .fails — your fix worked".
import type { TemplateOnlyComponent } from '@ember/component/template-only';

interface ListItemSig {
  Blocks: { default: [] };
  Element: HTMLLIElement;
}
const ListItem: TemplateOnlyComponent<ListItemSig> = <template>
  <li ...attributes>{{yield}}</li>
</template>;

interface ListLinkSig {
  Blocks: { default: [] };
  Element: HTMLAnchorElement;
}
const ListLink: TemplateOnlyComponent<ListLinkSig> = <template>
  <ListItem>
    <a href="#" ...attributes>{{yield}}</a>
  </ListItem>
</template>;

<template>
  <ul>
    <ListLink>One</ListLink>
    <ListLink>Two</ListLink>
  </ul>
</template>
