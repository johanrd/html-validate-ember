// Mirrors HDS HdsDropdownListItemTitle: a wrapper that invokes
// the polymorphic-tag component with a literal `@tag="li"`. The
// runtime DOM is `<li>` (because the inner polymorphic component
// honors the literal). Glint's TS-side resolution sees the union
// element type and arbitrarily picks the first match (`<h1>` from
// the heading branch); the chain trace overrides this with the
// literal `<li>`.
import type { TemplateOnlyComponent } from '@ember/component/template-only';
import PolymorphicText from './polymorphic-text-leaf.gts';

interface ListItemSig {
  Element: HTMLLIElement;
  Args: { text: string };
  Blocks: { default: [] };
}

const PolymorphicListItem: TemplateOnlyComponent<ListItemSig> = <template>
  <PolymorphicText @tag="li" ...attributes>{{@text}}</PolymorphicText>
</template>;

export default PolymorphicListItem;
