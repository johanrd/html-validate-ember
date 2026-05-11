// Wrapper: passes `@tag={{this.tag}}` through to the inner polymorphic
// component. Mirrors HdsFormHeaderTitle's pattern of computing the
// child's `@tag` value via a class getter (default 'div') and
// forwarding it via mustache.
import Component from '@glimmer/component';
import ThisPropInner from './this-prop-passthrough-inner-leaf.gts';

interface WrapperSig {
  Element: HTMLSpanElement | HTMLDivElement | HTMLParagraphElement;
  Args: { tag?: 'span' | 'div' | 'p' };
  Blocks: { default: [] };
}

export default class ThisPropWrapper extends Component<WrapperSig> {
  get tag(): 'span' | 'div' | 'p' {
    const { tag = 'div' } = this.args;
    return tag;
  }

  <template>
    <ThisPropInner @tag={{this.tag}} ...attributes>{{yield}}</ThisPropInner>
  </template>
}
