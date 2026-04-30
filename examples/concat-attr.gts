// Verifies that concat-mustache attribute values (mixed literal + dynamic)
// get DynamicValue treatment instead of leaving the literal portion exposed.
import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    {{!-- The literal "active-" should NOT be visible to html-validate. --}}
    <div class='active-{{this.suffix}}'>x</div>

    {{!-- popover with concat — literal-only portion looks like a valid value
         but the whole thing is dynamic. Should NOT mistakenly resolve to
         'auto-foo' or similar. --}}
    <div popover='auto-{{this.suffix}}'>y</div>

    {{!-- Boolean attr concat — should emit presence-only. --}}
    <input type='checkbox' checked='maybe-{{this.x}}' />

    {{!-- Two divs with concat ids that look textually different but both
         have a dynamic part. no-dup-id should NOT fire. --}}
    <div id='a-{{this.x}}'>a</div>
    <div id='b-{{this.x}}'>b</div>
  </template>
}
