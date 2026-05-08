// Outer wrapper around `<ConditionalLeaf>` (mirrors HdsButton wrapping
// HdsInteractive). The wrapper's template invokes ConditionalLeaf
// with extra args + `aria-label`. We want the chain-attr collection
// to combine: ConditionalLeaf's `<a href={{@href}}>` attrs (href +
// any others on that native) AND this wrapper's `aria-label`.
import type { TemplateOnlyComponent } from '@ember/component/template-only';
import ConditionalLeaf from './conditional-leaf-href.gts';

interface OuterButtonSig {
  Args: { href?: string; label?: string };
  Element: HTMLAnchorElement | HTMLButtonElement;
  Blocks: { default: [] };
}

const OuterButton: TemplateOnlyComponent<OuterButtonSig> = <template>
  <ConditionalLeaf @href={{@href}} aria-label={{@label}} ...attributes>
    {{yield}}
  </ConditionalLeaf>
</template>;

export default OuterButton;
