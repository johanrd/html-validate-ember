// Inner leaf: a polymorphic wrapper whose tag is driven by the
// consumer's `@tag` arg. Mirrors HdsText / HdsTextDisplay shape.
import Component from '@glimmer/component';

interface InnerSig {
  Element: HTMLSpanElement | HTMLDivElement | HTMLParagraphElement;
  Args: { tag?: 'span' | 'div' | 'p' };
  Blocks: { default: [] };
}

export default class ThisPropInner extends Component<InnerSig> {
  get componentTag(): 'span' | 'div' | 'p' {
    const { tag = 'span' } = this.args;
    return tag;
  }

  <template>
    {{#let (element this.componentTag) as |Tag|}}<Tag ...attributes>{{yield}}</Tag>{{/let}}
  </template>
}
