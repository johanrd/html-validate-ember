// `<form>` with both yield AND a static `<button>` (default type=submit
// inside a form). wcag/h32 wouldn't fire on this one — submit is
// statically present. Suppression must NOT activate; otherwise the
// injected `<!--html-validate-disable wcag/h32-->` would itself trigger
// `no-unused-disable`.
import Component from '@glimmer/component';

interface FormSig {
  Element: HTMLFormElement;
  Args: { onSubmit: () => void };
  Blocks: { default: [] };
}

export default class FormWithSubmit extends Component<FormSig> {
  handleSubmit = (e: Event): void => {
    e.preventDefault();
    this.args.onSubmit();
  };

  <template>
    <form {{on 'submit' this.handleSubmit}} ...attributes>
      {{yield}}
      <button type='submit'>Save</button>
    </form>
  </template>
}
