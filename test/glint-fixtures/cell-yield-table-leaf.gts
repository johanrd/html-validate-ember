// A `<table>` root whose named blocks yield at different depths:
// `caption` directly under `<table>`, `actions` inside a `<td>`, and
// `rows` inside `<tbody>`. Consumer content of a block lands where
// that block's `{{yield}}` sits, not under the `<table>` root.
import Component from '@glimmer/component';

interface Row {
  id: string;
  name: string;
}

interface CellYieldTableSig {
  Args: { rows: Row[] };
  Blocks: {
    caption: [];
    actions: [row: Row];
    rows: [];
  };
}

export default class CellYieldTable extends Component<CellYieldTableSig> {
  <template>
    <table>
      {{yield to='caption'}}
      <tbody>
        {{#each @rows as |row|}}
          <tr>
            <td>{{row.name}}</td>
            <td>{{yield row to='actions'}}</td>
          </tr>
        {{/each}}
        {{yield to='rows'}}
      </tbody>
    </table>
  </template>
}
