// Mirrors HDS's `<HdsForm>` shape: a wrapper component whose
// template renders `<form>{{yield}}</form>` literally. Glint resolves
// `<HdsForm>` to `<form>` via the Element type. The wcag/h32
// heuristic (added in fd7fb2a) needs to fire whether the consumer
// wrote `<form>` LITERALLY or via a Glint-resolved component
// substitution — without checking the resolved tag, the
// substituted-`<form>` consumer would FP-fire wcag/h32 even though
// the consumer's `{{yield}}`-bearing form clearly relies on
// caller-supplied submit markup.
import Component from '@glimmer/component';

interface MyFormSig {
  Element: HTMLFormElement;
  Blocks: { default: [] };
}

export default class MyForm extends Component<MyFormSig> {
  <template>
    <form ...attributes>{{yield}}</form>
  </template>
}
