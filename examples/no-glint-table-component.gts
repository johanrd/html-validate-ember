import Component from '@glimmer/component';
import { hash } from '@ember/helper';
import type { TOC } from '@ember/component/template-only';

// Mirrors HDS's `<HdsTable>` advanced shape: resolves to `<table>` and
// yields row/cell curried sub-components into a `:body` named block.
const Tr: TOC<{ Element: HTMLTableRowElement; Blocks: { default: [] } }> =
  <template><tr ...attributes>{{yield}}</tr></template>;
const Td: TOC<{ Element: HTMLTableCellElement; Blocks: { default: [] } }> =
  <template><td ...attributes>{{yield}}</td></template>;

export default class MyTable extends Component {
  Tr = Tr;
  Td = Td;
  <template>
    <table ...attributes>
      <tbody>{{yield (hash Tr=this.Tr Td=this.Td) to="body"}}</tbody>
    </table>
  </template>
}
