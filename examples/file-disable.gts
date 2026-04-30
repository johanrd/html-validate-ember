// File-level disable: an HTML comment at the top of the <template> block
// disables the named rule(s) for the rest of that template.
// Glimmer comments {{!-- ... --}} get blanked; HTML comments survive.
import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    <!-- [html-validate-disable attribute-allowed-values: project-wide opt-out] -->

    {{!-- Both of these would normally fire attribute-allowed-values; the
         file-level disable above suppresses them throughout the template. --}}
    <div dir='bogus'>x</div>
    <div dir='also-bogus'>y</div>
    <div dir='still-bogus'>z</div>
  </template>
}
