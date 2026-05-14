// Verifies the Prettier-collapsed short-form `{{! ... }}` works as an
// html-validate directive too. The blanker steals the inner padding
// spaces to absorb the marker-length delta and rewrite to `<!--…-->`
// in place, so html-validate's parser sees the directive without us
// shifting downstream offsets.
import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    {{! [html-validate-disable attribute-allowed-values: project opt-out] }}

    {{! All three would normally fire; the directive above suppresses them. }}
    <div dir='bogus'>x</div>
    <div dir='also-bogus'>y</div>
    <div dir='still-bogus'>z</div>
  </template>
}
