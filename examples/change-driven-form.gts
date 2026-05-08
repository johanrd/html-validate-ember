// Change-driven form (commit-on-blur / per-field-commit pattern).
// `{{on "change" …}}` fires when a field commits (input loses focus,
// select changes, checkbox toggles). The form's action runs per-field
// rather than at a final submit, so a submit button is ceremonial.
//
// Mirrors a pattern observed in the user's proapi-webapp codebase
// (cost-analysis.gts) where wcag/h32 was being silenced via inline
// `{{!-- html-validate-disable-next wcag/h32 --}}` directives.
import Component from '@glimmer/component';
import { action } from '@ember/object';
import { on } from '@ember/modifier';

interface Sig {
  Element: HTMLFormElement;
  Args: Record<string, never>;
  Blocks: { default: [] };
}

export default class ChangeDrivenForm extends Component<Sig> {
  @action
  handleCommit(event: Event): void {
    const target = event.target as HTMLInputElement;
    // commit `target.name = target.value` to the model on every change
    void target;
  }

  <template>
    <form {{on 'change' this.handleCommit}} ...attributes>
      <label>
        <span>Display name</span>
        <input name='displayName' type='text' />
      </label>
      <label>
        <span>Notifications</span>
        <input name='notify' type='checkbox' />
      </label>
    </form>
  </template>
}
