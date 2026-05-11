// `<ConditionalLeaf>` mirrors HdsInteractive: declares an interactive
// leaf type but the template's outermost is a top-level
// `{{#if}}/{{else}}` switching between `<a href={{@href}}>` and
// `<button>`. The walker descends through the BlockStatement to find
// the first reachable native (`<a href={{@href}}>`), and the
// chain-attr collection picks up `href` so consumer-side substitutions
// don't fire `aria-label-misuse` on an `<a>` without href.
import type { TemplateOnlyComponent } from '@ember/component/template-only';

interface ConditionalLeafSig {
  Args: { href?: string };
  Blocks: { default: [] };
  Element: HTMLAnchorElement | HTMLButtonElement;
}

const ConditionalLeaf: TemplateOnlyComponent<ConditionalLeafSig> = <template>
  {{#if @href}}
    <a href={{@href}} ...attributes>{{yield}}</a>
  {{else}}
    <button type="button" ...attributes>{{yield}}</button>
  {{/if}}
</template>;

export default ConditionalLeaf;
