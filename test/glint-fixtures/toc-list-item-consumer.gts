// Consumer fixture: imports TocListItem (a TOC with
// `Element: HTMLLIElement` declared via `satisfies TOC<…>`-style typing)
// and uses it inside a <ul>. The runtime DOM is <ul><li>...</li></ul>;
// Glint must resolve TocListItem → 'li' so html-validate's
// element-permitted-content rule doesn't FP-fire.
import { TocListItem } from './toc-list-item.gts';

<template>
  <ul>
    <TocListItem @title="One">first</TocListItem>
    <TocListItem @title="Two">second</TocListItem>
  </ul>
</template>
