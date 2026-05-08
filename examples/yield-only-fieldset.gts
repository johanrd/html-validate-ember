// `<fieldset>` wrapper that yields its body to the consumer (consumer
// supplies `<legend>` + form controls). Without suppression,
// `wcag/h71` (`<fieldset> must have a <legend> as the first child`)
// FP-fires because the blanker erases `{{yield}}` and html-validate
// sees an empty fieldset body. Same shape as <form>{{yield}}</form>.
import Component from '@glimmer/component';

interface FieldsetSig {
  Element: HTMLFieldSetElement;
  Args: { disabled?: boolean };
  Blocks: { default: [] };
}

export default class YieldOnlyFieldset extends Component<FieldsetSig> {
  <template>
    <fieldset disabled={{@disabled}} ...attributes>
      {{yield}}
    </fieldset>
  </template>
}
