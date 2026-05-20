import Component from '@glimmer/component';

// Regression: <th> directly under <thead> (no <tr> wrapper) is
// invalid HTML — <thead>'s content model is "zero or more <tr>".
// fix/38 unmasked this pattern by migrating element-permitted-content
// from file-level to per-element disable; any future over-broadening
// of table-suppression detection must continue to allow this rule to
// fire here.
export default class RegressionThUnderTheadWithoutTr extends Component {
  <template>
    <table>
      <thead>
        <th>Header A</th>
        <th>Header B</th>
        <th>Header C</th>
      </thead>
      <tbody>
        <tr>
          <td>cell</td>
          <td>cell</td>
          <td>cell</td>
        </tr>
      </tbody>
    </table>
  </template>
}
