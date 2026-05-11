// Mirrors HDS's `<HdsFormCheckboxBase>` shape: self-closing void
// component whose addon template carries a literal `type='checkbox'`
// but the consumer typically writes the invocation with NO Glimmer-
// only attrs (`<HdsFormCheckboxBase aria-label="…" />`). Without a
// `@arg=`/modifier slot, source-side `tryInjectInputType` finds no
// candidate range to inject `type='checkbox'` and the substituted
// `<input>` reaches html-validate type-less, FP-firing
// `no-implicit-input-type`.
//
// Hook-time setAttribute (parallel to imgSplat / aSplatHref) closes
// the gap: when source-side injection fails AND the chain records a
// `type` literal, push the consumer offset so the `processElement`
// hook calls setAttribute('type', literal) at parse time.
import Component from '@glimmer/component';

interface CheckboxSig {
  Element: HTMLInputElement;
  Args: Record<string, never>;
}

export default class MyCheckbox extends Component<CheckboxSig> {
  <template>
    <input type="checkbox" ...attributes />
  </template>
}
