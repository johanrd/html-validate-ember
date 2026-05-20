import Component from '@glimmer/component';

// Table whose header cells are produced by a PascalCase component
// that Glint resolves to <th>. With cell-loops in the body the
// table triggers `tableHasGlimmerObscuredCells` suppression — the
// per-element disable must also land on the component-resolved <th>
// cells, not just literal <th> nodes.
const COLUMNS = ['2023', '2024'];

interface MyHeaderCellSignature {
  Element: HTMLTableCellElement;
  Blocks: { default: [] };
}

class MyHeaderCell extends Component<MyHeaderCellSignature> {
  <template>
    <th scope='col'>{{yield}}</th>
  </template>
}

export default class TableComponentTh extends Component {
  <template>
    <table>
      <thead>
        <tr>
          <MyHeaderCell>corner</MyHeaderCell>
          <MyHeaderCell>year</MyHeaderCell>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>row1</td>
          {{#each COLUMNS as |c|}}
            <td>{{c}}</td>
          {{/each}}
        </tr>
      </tbody>
    </table>
  </template>
}
