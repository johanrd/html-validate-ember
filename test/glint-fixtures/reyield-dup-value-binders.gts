import { hash } from '@ember/helper';
import type { TOC } from '@ember/component/template-only';

interface LeafSig {
  Element: HTMLElement;
  Blocks: { default: [] };
}
const SectionLeaf: TOC<LeafSig> = <template><section ...attributes>{{yield}}</section></template>;
const ArticleLeaf: TOC<LeafSig> = <template><article ...attributes>{{yield}}</article></template>;

// Two binders that BOTH bind `F` and BOTH re-yield the same value
// `F.Item` — but under different outer keys. Resolving the `Thing` key
// must pick BinderB's binder (→ `<article>`), the one wrapping the
// `Thing=F.Item` entry, not the first `F.Item` occurrence (BinderA →
// `<section>`).
interface BinderSig {
  Element: HTMLElement;
  Blocks: { default: [{ Item: unknown }] };
}
const BinderA: TOC<BinderSig> = <template>{{yield (hash Item=SectionLeaf)}}</template>;
const BinderB: TOC<BinderSig> = <template>{{yield (hash Item=ArticleLeaf)}}</template>;
