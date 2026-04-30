// Verifies that html-validate inline directives (HTML comments) survive
// the blanker. Glimmer comments {{!-- ... --}} get blanked, but HTML
// comments <!-- ... --> pass through, so html-validate sees the directive.
import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    {{!-- This Glimmer comment gets blanked. --}}

    {{!-- The next div has dir='bogus' which would normally fire
         attribute-allowed-values. The HTML comment below disables the
         rule for the next element only. --}}
    <!-- [html-validate-disable-next attribute-allowed-values: dynamic dir, vendor lib] -->
    <div dir='bogus'>x</div>

    {{!-- This div is NOT preceded by a disable directive — should fire. --}}
    <div dir='also-bogus'>y</div>
  </template>
}
