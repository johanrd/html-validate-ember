import Component from '@glimmer/component';

// <button type='{{dynamic}}'> — type might be 'submit' at runtime.
// H32 looks for "submit button". Does the rule recognize a button
// with a dynamic type as potentially-submit?
export default class H32DynamicSubmitType extends Component<{
  Args: { btnType: 'submit' | 'button' };
}> {
  <template>
    <form>
      <input type='text' />
      <button type='{{@btnType}}'>Go</button>
    </form>
  </template>
}
