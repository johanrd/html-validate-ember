// `<form>` with `{{yield}}` AND a `<button type='button'>` (explicitly
// non-submit). wcag/h32 WOULD FP-fire on the blanked output (no
// statically-detectable submit), so the suppression must still kick
// in. The presence of an explicit non-submit button must NOT
// disqualify the form.
import Component from '@glimmer/component';

interface FormSig {
  Element: HTMLFormElement;
  Args: { onCancel: () => void };
  Blocks: { default: [] };
}

export default class FormWithCancel extends Component<FormSig> {
  handleCancel = (): void => {
    this.args.onCancel();
  };

  <template>
    <form ...attributes>
      {{yield}}
      <button type='button' {{on 'click' this.handleCancel}}>Cancel</button>
    </form>
  </template>
}
