// `<form>` vs `<div>` toggle, both arms with `{{yield}}` and no static
// submit. Multipass generates two passes (the arms produce different
// blanked output, so the multipass driver doesn't collapse them):
//   - Pass A: program → `<form>{{yield}}</form>` → wcag/h32 would FP-fire
//   - Pass B: inverse → `<div>{{yield}}</div>` → wcag/h32 wouldn't fire,
//             but the disable directive needs `no-unused-disable` so
//             it doesn't itself get flagged unused.
//
// The combined directive carries BOTH `no-unused-disable` and
// `wcag/h32`; html-validate's directive grammar requires
// comma-separated rule names. Space-separated silently disables only
// the first rule, leaving wcag/h32 to fire on the blanked program-pass
// output.
//
// Mirrors HDS `form/index.gts` (a `<form>` vs `<div>` toggle, both
// with `{{yield (hash …)}}`).
import Component from '@glimmer/component';

interface Sig {
  Element: HTMLFormElement;
  Args: { isForm: boolean };
  Blocks: { default: [] };
}

export default class BranchedBothYieldForm extends Component<Sig> {
  <template>
    {{#if @isForm}}
      <form ...attributes>
        {{yield}}
      </form>
    {{else}}
      <div ...attributes>
        {{yield}}
      </div>
    {{/if}}
  </template>
}
