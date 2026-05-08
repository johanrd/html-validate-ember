// `<ListItem>` — outermost native is `<li>`. Used by
// `<ListLink>` to wrap its anchor.
import type { TemplateOnlyComponent } from '@ember/component/template-only';

interface ListItemSig {
  Blocks: { default: [] };
  Element: HTMLLIElement;
}

const ListItem: TemplateOnlyComponent<ListItemSig> = <template>
  <li ...attributes>{{yield}}</li>
</template>;

export default ListItem;
