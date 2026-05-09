// File with multiple `<template>` blocks (Live first, Wrapper
// second). Mirrors limber's `apps/repl/app/templates/docs/support/
// api.gts` shape: a TOC `<Live>` (renders `<span>`) defined first,
// then a class component `Wrapper` (renders `<div>` with yields
// inside `<p>`) defined second.
//
// Bug: Glint resolution for `<Wrapper>` arbitrarily picked the
// FIRST template's splatted-root (`<span>` from Live) — wrong tag
// for any consumer of `Wrapper`. Wrapper-side resolution should
// either match by declaration→template or skip the template-root
// upgrade for multi-template files.
import Component from '@glimmer/component';
import type { TOC } from '@ember/component/template-only';

export const Live: TOC<{ Element: HTMLSpanElement }> = <template>
  <span class="live">⚡</span>
</template>;

export class Wrapper extends Component {
  <template>
    <div class="wrapper">
      <p>{{yield}}</p>
    </div>
  </template>
}
