// `<form>` whose body branches asymmetrically: program arm yields,
// inverse arm has a static `<button type='submit'>`. Under multipass,
// each arm validates independently:
//   - Program (yield-only) pass: blanker emits a form with no
//     statically-detectable submit, so wcag/h32 would FP-fire and
//     suppression must activate on THIS pass.
//   - Inverse (submit-button) pass: real submit visible, wcag/h32
//     wouldn't fire — suppression must NOT activate or
//     `no-unused-disable` would cascade.
// The branch-aware walker in `detectStructuralYieldRules` honors the
// per-pass `branchSelections` so each pass gets the right
// `disableForRules`. A walker that visited BOTH arms unconditionally
// (the prior behavior) would see the inverse arm's submit on the
// program pass too and never suppress wcag/h32, leaving the FP visible.
import Component from '@glimmer/component';

interface Sig {
  Element: HTMLFormElement;
  Args: { loading: boolean; onSubmit: () => void };
  Blocks: { default: [] };
}

export default class AsymmetricForm extends Component<Sig> {
  handleSubmit = (e: Event): void => {
    e.preventDefault();
    this.args.onSubmit();
  };

  <template>
    <form {{on 'submit' this.handleSubmit}} ...attributes>
      {{#if @loading}}
        {{yield}}
      {{else}}
        <button type='submit'>Save</button>
      {{/if}}
    </form>
  </template>
}
