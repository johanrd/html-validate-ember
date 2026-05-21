import { hash } from '@ember/helper';
import type { TOC } from '@ember/component/template-only';

// `NavList` is an in-scope const component, NOT a block param introduced
// via `<… as |NavList|>`. A hash entry `NavList.Item` is therefore plain
// property access, not a block-param re-yield: `resolveBlockParamReyield`
// must find no binder and the caller must fall back to resolving the head
// (`NavList`) by name — landing on `<nav>` rather than TRANSPARENT.
interface NavSig {
  Element: HTMLElement;
  Blocks: { default: [{ Item: unknown }] };
}
const NavList: TOC<NavSig> = <template>
  <nav ...attributes>{{yield (hash Item="x")}}</nav>
</template>;
