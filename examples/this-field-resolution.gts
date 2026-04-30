// Verifies `{{this.field}}` resolves to the class-field initializer's
// literal value. The field below has an INVALID `dir` value; with
// resolution working, html-validate's `attribute-allowed-values` rule
// catches it. Without resolution, the mustache becomes DynamicValue
// and the rule can't enforce it.
import Component from '@glimmer/component';

export default class Demo extends Component {
  textDir = 'bogus';

  <template>
    <p dir={{this.textDir}}>x</p>
  </template>
}
