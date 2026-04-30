// Comprehensive fixture: every Glimmer mustache+component construct,
// plus one real attribute-allowed-values violation we expect to see flagged.
import Component from '@glimmer/component';

export default class Demo extends Component {
  greeting = "hello";

  <template>
    <div dir="bogus">
      static text {{this.greeting}} more text
    </div>

    <span class="foo {{this.greeting}} bar" id={{this.greeting}}>x</span>

    {{!-- a comment that should not confuse anything --}}

    {{some-helper this.greeting}}

    {{#if this.greeting}}
      <span>then</span>
    {{else}}
      <em>else</em>
    {{/if}}

    <button {{on "click" this.handler}} type="button">click me</button>

    <MyButton @arg={{42}} ...attributes>
      this entire thing should be blanked
    </MyButton>

    <div ...attributes class="legitimate"></div>
  </template>
}
