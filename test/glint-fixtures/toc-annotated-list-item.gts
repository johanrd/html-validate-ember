// Cross-file fixture: TOC declared via the *type-annotation* form
//   `const X: TOC<{Element: T}> = <template>...</template>;`
// rather than the `satisfies` form (covered by toc-list-item.gts).
// Both shapes hit the same emit path and need the same recovery in
// `resolveElementFromTOCDeclaration`.
import type { TOC } from '@ember/component/template-only';

interface AnnotatedSig {
  Element: HTMLLIElement;
  Args: { title: string };
  Blocks: { default: [] };
}

export const TocAnnotatedListItem: TOC<AnnotatedSig> = <template>
  <li class="annotated" ...attributes>{{yield}}</li>
</template>;
