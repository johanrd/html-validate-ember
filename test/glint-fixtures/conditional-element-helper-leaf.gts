// Mirrors HDS HdsCardContainer: a class component whose template
// branches on `(eq this.componentTag "div")` and otherwise uses the
// `(element this.componentTag)` helper. The `componentTag` getter
// destructures `@tag` with a default literal.
import Component from '@glimmer/component';

interface ConditionalElementHelperSig {
  Element: HTMLDivElement | HTMLLIElement | HTMLElement;
  Args: { tag?: 'div' | 'li' | 'section' };
  Blocks: { default: [] };
}

const DEFAULT_TAG = 'div' as const;

export default class ConditionalElementHelper extends Component<ConditionalElementHelperSig> {
  get componentTag(): 'div' | 'li' | 'section' {
    const { tag = DEFAULT_TAG } = this.args;
    return tag;
  }

  <template>
    {{#if (eq this.componentTag "div")}}
      <div ...attributes>{{yield}}</div>
    {{else}}
      {{#let (element this.componentTag) as |Tag|}}
        <Tag ...attributes>{{yield}}</Tag>
      {{/let}}
    {{/if}}
  </template>
}
