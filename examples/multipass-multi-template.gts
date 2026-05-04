// Multi-template `.gts`: a non-branched helper template alongside the
// main branched component template. Verifies that suppressing the
// `no-unused-disable` FP inside the branched template DOESN'T also
// suppress real `no-unused-disable` reports from non-branched
// templates in the same file.
//
// Header has a `no-dup-id` directive on a single `<p>` — the rule has
// nothing to suppress there, so `no-unused-disable` SHOULD fire.
// Main has the multipass FP pattern (directive needed in the
// no-submit branch, looks unused in the submit branch).
import Component from '@glimmer/component';

export const Header = <template>
  {{!-- [html-validate-disable-next no-dup-id -- intentionally unused] --}}
  <p>header</p>
</template>;

export default class Main extends Component {
  get loading() {
    return false;
  }

  handleSubmit = () => {};

  <template>
    {{!-- [html-validate-disable-next wcag/h32 -- needed in no-submit branch] --}}
    <form {{on 'submit' this.handleSubmit}}>
      {{#if this.loading}}
        <button type='button'>Cancel</button>
      {{else}}
        <button type='submit'>Send</button>
      {{/if}}
    </form>
  </template>
}
