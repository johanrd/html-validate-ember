// Mirrors HDS HdsDialogPrimitiveHeader's own-template pattern:
// `{{#let (element this.titleTag) as |Tag|}}<Tag>...</Tag>{{/let}}`
// where `this.titleTag` is a class getter returning a string literal
// (typically the destructured `@titleTag` arg defaulted to 'div'
// via `?? DEFAULT_TAG`).
//
// Without the own-template let-element resolution, `<Tag>` is a
// let-block-param whose declaring file IS the consumer — the
// canonical resolver bails (declFile not top-level), and Glint's
// TS-side picks the first matching member from the `(element …)`
// helper's return-type union (typically <h1> from HTMLHeadingElement
// when the union includes heading tags). Downstream
// `element-permitted-content` rules then FP-fire on legal
// <div>/<span> children placed under what html-validate now thinks
// is an <h1>.
import Component from '@glimmer/component';
import { element } from 'ember-element-helper';

type TitleTag = 'div' | 'span' | 'h1' | 'h2';

interface OwnLetSig {
  Element: HTMLHeadingElement | HTMLDivElement | HTMLSpanElement;
  Args: { titleTag?: TitleTag };
  Blocks: { default: [] };
}

export default class OwnLet extends Component<OwnLetSig> {
  get titleTag(): TitleTag {
    return this.args.titleTag ?? 'div';
  }

  <template>
    {{#let (element this.titleTag) as |Tag|}}
      <Tag ...attributes>
        <div class="inner">{{yield}}</div>
      </Tag>
    {{/let}}
  </template>
}
