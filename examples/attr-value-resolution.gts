// Tests resolution of static-text helpers in attribute value positions.
import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    {{!-- t-helper resolves to literal --}}
    <input aria-label={{t 'Search'}} type='text' />

    {{!-- if-helper picks first literal branch --}}
    <button class={{if this.active 'is-active' 'is-inactive'}} type='button'>x</button>

    {{!-- A real bug we'd hope to catch: invalid popover value via if --}}
    <div popover={{if this.x 'auto' 'bogus'}}>x</div>

    {{!-- Static text via t-helper inside aria-label --}}
    <div aria-label={{t 'Open menu'}}></div>
  </template>
}
