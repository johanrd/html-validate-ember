// Inner polymorphic-tag leaf with a class-getter default. Mirrors
// HdsFormHeaderTitle: `@tag` arg with destructure default to 'div'.
import Component from '@glimmer/component';

interface InnerSig {
  Element: HTMLHeadingElement | HTMLDivElement | HTMLSpanElement;
  Args: { tag?: 'div' | 'h1' | 'span'; size?: string };
  Blocks: { default: [] };
}

export default class CurryInner extends Component<InnerSig> {
  get componentTag(): 'div' | 'h1' | 'span' {
    const { tag = 'div' } = this.args;
    return tag;
  }

  <template>
    {{#let (element this.componentTag) as |Tag|}}<Tag ...attributes>{{yield}}</Tag>{{/let}}
  </template>
}
