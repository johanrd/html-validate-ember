// `<form>` with `{{yield}}` AND a `<SubmitButton />` component
// invocation. SubmitButton's splatted root is `<button type='submit'
// ...attributes>`; Glint resolves the component to native `<button>`
// with `type='submit'`. After substitution the blanked output has a
// REAL submit, so wcag/h32 wouldn't fire — the injected
// `<!--html-validate-disable wcag/h32-->` would itself trigger
// `no-unused-disable`. The static-submit detector must recognize the
// component invocation as a submit, not just literal `<button>`.
import Component from '@glimmer/component';

import SubmitButton from './submit-button.gts';

interface Sig {
  Element: HTMLFormElement;
  Args: { onSubmit: () => void };
  Blocks: { default: [] };
}

export default class FormWithComponentSubmit extends Component<Sig> {
  handleSubmit = (e: Event): void => {
    e.preventDefault();
    this.args.onSubmit();
  };

  <template>
    <form {{on 'submit' this.handleSubmit}} ...attributes>
      {{yield}}
      <SubmitButton>Save</SubmitButton>
    </form>
  </template>
}
