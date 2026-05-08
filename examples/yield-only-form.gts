// `<form>` wrapper that yields its body to the consumer (consumer
// supplies the submit button). Without suppression, `wcag/h32`
// (`<form> element must have a submit button`) FP-fires because the
// blanker erases `{{yield}}` and html-validate sees an empty form body.
// `detectStructuralYieldRules` in `blank.ts` flags this and the
// transformer prepends a Source-level `wcag/h32` disable directive.
import Component from '@glimmer/component';

interface FormSig {
  Element: HTMLFormElement;
  Args: { onSubmit: () => void };
  Blocks: { default: [] };
}

export default class YieldOnlyForm extends Component<FormSig> {
  handleSubmit = (e: Event): void => {
    e.preventDefault();
    this.args.onSubmit();
  };

  <template>
    <form {{on 'submit' this.handleSubmit}} ...attributes>
      {{yield}}
    </form>
  </template>
}
