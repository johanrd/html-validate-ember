// Verifies bare-mustache attribute handling for both boolean and non-boolean.
import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    {{!-- Non-boolean: should emit `id="<spaces>"` and the processAttribute
         hook should convert to DynamicValue. --}}
    <div id={{this.divId}} class={{this.divClass}}>x</div>

    {{!-- Boolean: should emit `disabled` (presence-only) — one of the two
         valid runtime forms per docs/glimmer-attribute-behavior.md. --}}
    <input type="text" disabled={{this.disabled}} />
    <button required={{this.required}}>x</button>

    {{!-- Two divs with the same dynamic id — html-validate's no-dup-id
         rule should NOT fire here because both are DynamicValue (unknowable
         at parse time). --}}
    <div id={{this.someId}}>a</div>
    <div id={{this.someId}}>b</div>

    {{!-- Two divs with the SAME static id — no-dup-id SHOULD fire. --}}
    <div id="static-dup">a</div>
    <div id="static-dup">b</div>
  </template>
}
