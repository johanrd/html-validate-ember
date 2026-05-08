// Multipass false-negative regression: the inverse arm has a
// genuinely-broken `<form>` (no submit, no yield — wcag/h32 SHOULD
// fire), and the program arm has a yield-only `<form>` (legitimate
// suppression target).
//
// Without a branch-aware top-level traversal, `detectStructuralYieldRules`
// would visit BOTH forms via `traverse(ast, { ElementNode })`, see the
// program arm's yield, decide "this Source needs wcag/h32 suppressed",
// and inject a `<!--html-validate-disable wcag/h32-->` directive into
// the inverse pass too — silently masking the real bug in the inverse
// arm.
//
// The branch-aware top-level walk descends only into the selected arm
// per pass, so the inverse pass's `disableForRules` no longer carries
// `wcag/h32`, and wcag/h32 fires correctly on the inverse arm's
// genuinely-broken form.
import Component from '@glimmer/component';

interface Sig {
  Element: HTMLElement;
  Args: { showYieldedForm: boolean };
  Blocks: { default: [] };
}

export default class FormInBlankedBranch extends Component<Sig> {
  <template>
    {{#if @showYieldedForm}}
      <form ...attributes>
        {{yield}}
      </form>
    {{else}}
      <form ...attributes>
        <textarea name='message'></textarea>
      </form>
    {{/if}}
  </template>
}
