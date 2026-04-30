// Top-level string consts that the transformer should resolve when used
// in mustache positions.
const PAGE_TITLE = 'Welcome to the app';
const POPOVER_MODE = 'auto';
const FORM_METHOD = 'post';
const BAD_POPOVER = 'bogus';

import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    <h1>{{PAGE_TITLE}}</h1>

    {{!-- popover with valid resolved const --}}
    <div popover={{POPOVER_MODE}}>x</div>

    {{!-- popover with INVALID resolved const — html-validate should catch --}}
    <div popover={{BAD_POPOVER}}>y</div>

    {{!-- form method resolved const, valid --}}
    <form method={{FORM_METHOD}}>
      <input type='text' name='x' />
    </form>
  </template>
}
