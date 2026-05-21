import { hash } from '@ember/helper';
import type { TOC } from '@ember/component/template-only';

interface LeafSig {
  Element: HTMLElement;
  Blocks: { default: [] };
}
const Leaf: TOC<LeafSig> = <template><article ...attributes>{{yield}}</article></template>;

// Binder yields `Inner=Leaf`. A parent that re-yields `Section=F.Inner`
// (F bound by `<Binder as |F|>`) must be followable at the SOURCE level
// (resolveYieldHashBindingSource) down to Leaf — not just at the leaf
// resolver — so deeper dotted chains off the re-yielded component work.
interface BinderSig {
  Element: HTMLElement;
  Blocks: { default: [{ Inner: unknown }] };
}
const Binder: TOC<BinderSig> = <template>{{yield (hash Inner=Leaf)}}</template>;
