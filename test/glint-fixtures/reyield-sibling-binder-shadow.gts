import { hash } from '@ember/helper';
import type { TOC } from '@ember/component/template-only';

interface LeafSig {
  Element: HTMLElement;
  Blocks: { default: [] };
}
const SectionLeaf: TOC<LeafSig> = <template><section ...attributes>{{yield}}</section></template>;
const ArticleLeaf: TOC<LeafSig> = <template><article ...attributes>{{yield}}</article></template>;

// Two binders, BOTH binding the short param name `F`. The re-yield
// reference `F.Item` lives inside BinderB, so resolution must pick
// BinderB (→ `<article>`), not the first `F` binder BinderA (→ `<section>`).
interface BinderSig {
  Element: HTMLElement;
  Blocks: { default: [{ Item: unknown }] };
}
const BinderA: TOC<BinderSig> = <template>{{yield (hash Item=SectionLeaf)}}</template>;
const BinderB: TOC<BinderSig> = <template>{{yield (hash Item=ArticleLeaf)}}</template>;
