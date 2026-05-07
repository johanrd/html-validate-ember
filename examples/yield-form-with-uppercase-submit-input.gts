// `<form>` with `{{yield}}` AND `<input type='Submit'>`. HTML attribute
// values are ASCII case-insensitive, so this IS a static submit.
// Suppression must NOT activate; otherwise the injected
// `<!--html-validate-disable wcag/h32-->` would itself trigger
// `no-unused-disable` (html-validate normalizes the type).
import Component from '@glimmer/component';

interface FormSig {
  Element: HTMLFormElement;
  Args: { onSubmit: () => void };
  Blocks: { default: [] };
}

export default class FormWithUppercaseSubmit extends Component<FormSig> {
  handleSubmit = (e: Event): void => {
    e.preventDefault();
    this.args.onSubmit();
  };

  <template>
    <form {{on 'submit' this.handleSubmit}} ...attributes>
      {{yield}}
      <input type='Submit' value='Save' />
    </form>
  </template>
}
