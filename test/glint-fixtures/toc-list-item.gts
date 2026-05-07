// Cross-file fixture for the TOC `satisfies TOC<{Element: T}>` form.
// Ember-a11y-testing's `ViolationsGridItem` and HDS's various
// `<X.List.Item>` components use this form rather than `class extends
// Component<Sig>`. Glint's DSL emit currently produces `any` for the
// element type on TOCs declared this way, so `resolveComponentElement`
// returns 'transparent' and children float to the actual parent
// (e.g. `<ul>` instead of being correctly seen as inside `<li>`).
import type { TOC } from '@ember/component/template-only';

export const TocListItem = <template>
  <li class="card" ...attributes>{{yield}}</li>
</template> satisfies TOC<{
  Element: HTMLLIElement;
  Args: { title: string };
  Blocks: { default: [] };
}>;
