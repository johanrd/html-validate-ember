// `<ListLink>` declares `Element: HTMLAnchorElement` (the leaf
// interactive type Glint reads). Its template wraps the `<a>` in
// `<ListItem>` (which renders `<li>`). At runtime the outermost
// element is `<li>`, but Glint's leaf-type resolution sees only
// `<a>`.
import type { TemplateOnlyComponent } from '@ember/component/template-only';
import ListItem from './leaf-element-list-item.gts';

interface ListLinkSig {
  Blocks: { default: [] };
  Element: HTMLAnchorElement;
}

const ListLink: TemplateOnlyComponent<ListLinkSig> = <template>
  <ListItem>
    <a href="#" ...attributes>{{yield}}</a>
  </ListItem>
</template>;

export default ListLink;
