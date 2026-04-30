// Verifies that `wcag/h32` (form must have submit button) doesn't FP when
// the `<button type='submit'>` lives in the `{{else}}` branch.
//
// Default single-branch emission picks the program (truthy) branch and
// blanks the inverse — which would hide the submit button. Fix: when only
// the inverse contains a submit button, prefer it.
import Component from '@glimmer/component';

export default class Demo extends Component {
  get isStreaming() {
    return false;
  }

  handleSubmit = () => {};

  <template>
    <form {{on 'submit' this.handleSubmit}}>
      <textarea name='message' aria-label='Message' rows='2'></textarea>

      {{#if this.isStreaming}}
        <button type='button'>Stop</button>
      {{else}}
        <button type='submit'>Send</button>
      {{/if}}
    </form>
  </template>
}
