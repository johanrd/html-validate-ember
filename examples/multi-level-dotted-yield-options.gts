// Mirrors HDS's `<HdsFormSelectField as |F|><F.Options><option>...`
// shape at filter-bar/filter-group/date.gts:286. Surfaced as +120
// FPs of `<option> not permitted under <div>` when the canonical-
// resolver rewrite changed how multi-level yield-hash chains resolve.
//
// SelectField resolves to <select> via Element type. F.Options is a
// curried-yield-hash component (typeof YieldOnly) that resolves to
// 'transparent' (YieldOnly has no Element). Without case-C suppression
// firing on the (pinned-to-structural-parent + transparent-curried-
// child) pair, the literal `<option>`s float past the blanked
// `<F.Options>` tags into whatever ancestor exists — typically the
// outer `<div>` wrapping the consumer's call site — and FP-fire
// `element-permitted-content`.
import type { TemplateOnlyComponent } from '@ember/component/template-only';

interface YieldOnlySig {
  Blocks: { default: [] };
}
const YieldOnly: TemplateOnlyComponent<YieldOnlySig> = <template>
  {{yield}}
</template>;

interface SelectFieldSig {
  Blocks: { default: [{ Options?: typeof YieldOnly }] };
  Element: HTMLSelectElement;
}
const SelectField: TemplateOnlyComponent<SelectFieldSig> = <template>
  <select ...attributes>
    {{yield (hash Options=YieldOnly)}}
  </select>
</template>;

<template>
  <div>
    <SelectField as |F|>
      <F.Options>
        <option value="a">A</option>
        <option value="b">B</option>
      </F.Options>
    </SelectField>
  </div>
</template>
