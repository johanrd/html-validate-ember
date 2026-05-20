import Component from '@glimmer/component';

const COLUMNS = ['2023', '2024', '2025'];

export default class TableCellEachComponent extends Component {
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
  </template>
}
