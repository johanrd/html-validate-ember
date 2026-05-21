import Component from '@glimmer/component';
import { hash } from '@ember/helper';
import type { TOC } from '@ember/component/template-only';

interface LegendSig { Element: HTMLLegendElement; Blocks: { default: [] } }
const Legend: TOC<LegendSig> = <template><legend ...attributes>{{yield}}</legend></template>;

interface InnerSig { Element: HTMLFieldSetElement; Blocks: { default: [{ Legend: typeof Legend }] } }
class InnerFieldset extends Component<InnerSig> {
  Legend = Legend;
  <template><fieldset ...attributes>{{yield (hash Legend=this.Legend)}}</fieldset></template>
}

// Re-yields F.Legend (the nested fieldset's yielded sub-component) —
// mirrors HdsFormCheckboxGroup re-yielding HdsFormFieldset's F.Legend.
interface OuterSig { Element: HTMLFieldSetElement; Blocks: { default: [{ Legend: typeof Legend }] } }
class OuterGroup extends Component<OuterSig> {
  <template>
    <InnerFieldset as |F|>
      {{yield (hash Legend=F.Legend)}}
    </InnerFieldset>
  </template>
}

<template>
  <OuterGroup as |G|>
    <G.Legend>Group legend</G.Legend>
    <input type="checkbox" />
  </OuterGroup>
</template>
