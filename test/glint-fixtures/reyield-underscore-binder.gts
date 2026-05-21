import { hash } from '@ember/helper';
import type { TOC } from '@ember/component/template-only';

interface LeafSig {
  Element: HTMLElement;
  Blocks: { default: [] };
}
const Aside: TOC<LeafSig> = <template><aside ...attributes>{{yield}}</aside></template>;

// Binder tag has an underscore — a resolvable wrapper the rest of the
// resolver accepts (`/^[A-Z]/`, not dotted, not `:slot`), but which the
// old `/^[A-Z][A-Za-z0-9]*$/` binder regex rejected, dropping the re-yield
// chain. Its `Item` re-yields `<Aside>` (→ `<aside>`).
interface BinderSig {
  Element: HTMLElement;
  Blocks: { default: [{ Item: unknown }] };
}
const My_Binder: TOC<BinderSig> = <template>{{yield (hash Item=Aside)}}</template>;
