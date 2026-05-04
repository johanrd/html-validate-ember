// Regression for the multipass `no-unused-disable` catch-22:
//
//   - In the `inner=program` branch combination the form has no submit
//     button, so `wcag/h32` fires on `<form>` and the directive correctly
//     suppresses it.
//   - In the `inner=inverse` branch combination the form HAS a submit
//     button, so `wcag/h32` doesn't fire — and `no-unused-disable` then
//     fires on the directive comment.
//
// Naive multipass dedupe surfaces the `no-unused-disable` from the
// inverse pass; the user can neither keep nor remove the directive
// without an error. The dedupe must recognize that the directive
// suppressed something in another pass and drop the unused report.
import Component from '@glimmer/component';

export default class Demo extends Component {
  get loading() {
    return false;
  }

  handleSubmit = () => {};

  <template>
    {{!-- [html-validate-disable-next wcag/h32 -- needed in inner=program branch] --}}
    <form {{on 'submit' this.handleSubmit}}>
      <textarea name='message' aria-label='Message' rows='2'></textarea>
      {{#if this.loading}}
        <button type='button'>Cancel</button>
      {{else}}
        <button type='submit'>Send</button>
      {{/if}}
    </form>
  </template>
}
