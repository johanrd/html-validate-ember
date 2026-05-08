// Sibling component used by `yield-form-with-component-submit.gts`.
// Splatted root is `<button type='submit' ...attributes>` — Glint
// resolves <SubmitButton /> to native `<button>` with static
// `type='submit'`, which detectStructuralYieldRules must recognize as
// a static submit (otherwise the form's wcag/h32 suppression would
// activate on a form that already has a real submit, triggering
// no-unused-disable on the injected disable directive).
import Component from '@glimmer/component';

interface Sig {
  Element: HTMLButtonElement;
  Args: Record<string, never>;
  Blocks: { default: [] };
}

export default class SubmitButton extends Component<Sig> {
  <template>
    <button type='submit' ...attributes>
      {{yield}}
    </button>
  </template>
}
