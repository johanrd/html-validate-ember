// `<form>` containing an UNRESOLVED PascalCase component that
// (presumably) provides the submit button at runtime. The component's
// source isn't Glint-typed (no @Element annotation), isn't in
// node_modules where the classic-by-name resolver looks, and isn't a
// builtin — so `componentTagMap` has no concrete native tag for it.
//
// At runtime, button-style components (e.g. addon-shipped `<XButton
// @type="submit">`) render real `<button>`s, but our static blanker
// can't see that — especially when the component's template uses a
// dynamic-element pattern (`<this.wrapperElement type={{...}}>`).
// Without this heuristic wcag/h32 would FP-fire because the form
// looks empty of submit candidates from the validator's view.
//
// Heuristic: when a `<form>` contains an unresolved PascalCase
// component AND lacks a statically-detectable submit, the rule
// suppresses for the Source — the component MIGHT render submit at
// runtime. Same per-Source-suppression trade-off as the
// yield-bearing-form case (PR #17): real bugs at OTHER locations in
// the same template get suppressed too. Acceptable given the volume
// of these FPs in real-world Ember code.
import Component from '@glimmer/component';

interface Sig {
  Element: HTMLFormElement;
  Args: { onSubmit: () => void };
  Blocks: { default: [] };
}

export default class FormWithUnresolvedComponentSubmit extends Component<Sig> {
  handleSubmit = (e: Event): void => {
    e.preventDefault();
    this.args.onSubmit();
  };

  <template>
    <form {{on 'submit' this.handleSubmit}} ...attributes>
      <input type="text" name="email" />
      <SubmitWidget @label="Save" />
    </form>
  </template>
}
