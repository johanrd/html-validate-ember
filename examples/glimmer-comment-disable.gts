// Verifies that html-validate directives work inside Glimmer comments
// {{!-- ... --}} too — the blanker rewrites them as HTML comments in
// place. Lets users honor `ember/template-no-html-comments` while still
// suppressing html-validate rules.
import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    {{!-- [html-validate-disable attribute-allowed-values: project opt-out] --}}

    {{!-- All three would normally fire; the directive above suppresses them. --}}
    <div dir='bogus'>x</div>
    <div dir='also-bogus'>y</div>
    <div dir='still-bogus'>z</div>
  </template>
}
