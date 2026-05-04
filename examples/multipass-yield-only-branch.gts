// Regression for the multipass `wcag/h32` FP on a `{{yield}}`-only
// branch:
//
//   - Inverse branch contains the default `<button type='submit'>`.
//   - Program branch contains only `{{yield}}` — opaque content the
//     consumer might fill with a submit, but the blanker can't see
//     into it. After blanking, the form looks empty → `wcag/h32`
//     fires in that pass.
//
// The user's intent ("if you provide a block, you're responsible for
// its content; otherwise we render the default submit") is satisfied
// at runtime in both branches. The validator has no way to know
// without modeling yields, so it should not surface `wcag/h32` here.
import Component from '@glimmer/component';

export default class YieldForm extends Component {
  handleSubmit = () => {};

  <template>
    <form {{on 'submit' this.handleSubmit}}>
      {{#if (has-block)}}
        {{yield}}
      {{else}}
        <button type='submit'>Save</button>
      {{/if}}
    </form>
  </template>
}
