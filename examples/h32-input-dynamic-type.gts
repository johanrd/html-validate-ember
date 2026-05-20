import Component from '@glimmer/component';

// Same as h32-dynamic-submit-type but with <input type='{{x}}'>
// instead of <button>. At runtime x might be 'submit' or 'image'
// (both count as submit) or something else.
export default class H32InputDynamicType extends Component<{
  Args: { inputType: 'submit' | 'text' };
}> {
  <template>
    <form>
      <input type='text' />
      <input type='{{@inputType}}' value='Go' />
    </form>
  </template>
}
