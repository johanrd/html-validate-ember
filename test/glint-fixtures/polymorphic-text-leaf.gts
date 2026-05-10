// Mirrors HDS HdsText: a polymorphic-tag wrapper using the Glimmer
// `(element ...)` helper to render whatever tag `this.componentTag`
// resolves to. The class getter destructures `@tag` with a default,
// then returns it.
import Component from '@glimmer/component';

interface PolymorphicTextSig {
  Element: HTMLSpanElement | HTMLHeadingElement | HTMLParagraphElement | HTMLDivElement;
  Args: { tag?: string };
  Blocks: { default: [] };
}

export default class PolymorphicText extends Component<PolymorphicTextSig> {
  get componentTag(): string {
    const { tag = 'span' } = this.args;
    return tag;
  }

  <template>
    {{#let (element this.componentTag) as |Tag|}}<Tag ...attributes>{{yield}}</Tag>{{/let}}
  </template>
}
