import Component from '@glimmer/component';

// Form with BOTH `{{yield}}` AND a dynamic-typed button. Two
// independent signals say "suppress h32"; verify both compose
// correctly and the form's h32 doesn't fire. Regression guard for
// the prior trade-off where `hasAmbiguousSubmit` would have set
// `hasStaticSubmit` and BLOCKED suppression even when yield was
// also present.
export default class H32YieldAndAmbiguousSubmit extends Component<{
  Args: { btnType: 'submit' | 'button' };
}> {
  <template>
    <form>
      {{yield}}
      <button type='{{@btnType}}'>Go</button>
    </form>
  </template>
}
