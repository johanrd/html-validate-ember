import Component from '@glimmer/component';

// Mirrors the shape of a table whose rows are rendered by a PascalCase
// component invocation (e.g., <MyRow ... />). The component renders a
// <tr> at runtime, but the blanker can't see through to it without a
// Glint resolution — so the <tbody> appears empty in the blanked
// output. Used to reproduce the wcag/h63 FP class where the static
// <thead> alone (no body rows) tickles a rule path we want to suppress.
class MyRow extends Component<{ Args: { label: string } }> {
  <template>
    <tr><td>{{@label}}</td><td>a</td><td>b</td><td>c</td></tr>
  </template>
}

export default class TableComponentRowsComponent extends Component {
  <template>
    <table>
      <thead>
        <tr>
          <th></th>
          <th scope='col'>One</th>
          <th scope='col'>Two</th>
          <th scope='col' colspan='2'>Three</th>
        </tr>
      </thead>
      <tbody>
        <MyRow @label='Row A' />
        <MyRow @label='Row B' />
      </tbody>
    </table>
  </template>
}
