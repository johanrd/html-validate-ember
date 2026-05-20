import Component from '@glimmer/component';

const COLUMNS = ['2023', '2024', '2025'];

// Two tables in one template:
//
//   Table A — has `{{#each}}<td>…</td>{{/each}}` cells. h63 fires
//             today (FP) because blanker collapses the loop body to
//             a single iteration. Should be SUPPRESSED.
//
//   Table B — genuinely irregular static markup: thead has 4 <th>
//             but body row has only 3 <td>. Real bug per H63.
//             Should STILL FIRE.
//
// With file-level disable, Table B's real bug is silenced too. With
// per-element disable, only Table A is suppressed and Table B's h63
// still surfaces.
export default class MultiTableMixed extends Component {
  <template>
    <table>
      <thead>
        <tr>
          <th></th>
          <th scope='col'>2023</th>
          <th scope='col'>2024</th>
          <th scope='col'>2025</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Diesel</td>
          {{#each COLUMNS as |col|}}
            <td>x-{{col}}</td>
          {{/each}}
        </tr>
      </tbody>
    </table>

    <table>
      <thead>
        <tr>
          <th></th>
          <th scope='col'>A</th>
          <th scope='col'>B</th>
          <th scope='col'>C</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>row1</td>
          <td>a</td>
          <td>b</td>
        </tr>
      </tbody>
    </table>
  </template>
}
