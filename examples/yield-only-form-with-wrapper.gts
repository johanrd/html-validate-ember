// `<form>` whose body wraps `{{yield}}` in non-submit markup. wcag/h32
// would FP-fire because the blanker erases the yield (consumer provides
// submit at runtime). Suppression should still kick in even though the
// body has structural element children — the wrapper itself isn't a
// submit-style element.
import Component from '@glimmer/component';

interface FormSig {
  Element: HTMLFormElement;
  Args: { onSubmit: () => void };
  Blocks: { default: [] };
}

export default class WrappedForm extends Component<FormSig> {
  handleSubmit = (e: Event): void => {
    e.preventDefault();
    this.args.onSubmit();
  };

  <template>
    <form {{on 'submit' this.handleSubmit}} ...attributes>
      <div class="form-body">
        {{yield}}
      </div>
    </form>
  </template>
}
