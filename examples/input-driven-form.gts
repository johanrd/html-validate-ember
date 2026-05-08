// Input-driven form (search-as-you-type / live-filter pattern). The
// `{{on "input"}}` modifier wires the form to update on every keystroke;
// a separate submit button would be ceremonial. wcag/h32's "form must
// have a submit button" technique is one way to satisfy WCAG SC 3.2.2,
// but input-driven forms satisfy 3.2.2 by being predictable on input.
//
// Without plugin-side suppression, every Ember search-as-you-type form
// FP-fires wcag/h32 — forcing developers to add hidden submit buttons
// (ceremonial code that helps no real user) or `{{!-- html-validate-
// disable-next wcag/h32 --}}` directives (noise). Detect the
// `{{on "input"}}` signal and suppress.
import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { on } from '@ember/modifier';

interface Sig {
  Element: HTMLFormElement;
  Args: Record<string, never>;
  Blocks: { default: [] };
}

export default class InputDrivenForm extends Component<Sig> {
  @tracked query = '';

  @action
  updateQuery(event: Event): void {
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    this.query = (formData.get('q') as string) ?? '';
  }

  <template>
    <form {{on 'input' this.updateQuery}} ...attributes>
      <label>
        <span>Search</span>
        <input name='q' type='search' />
      </label>
    </form>
  </template>
}
