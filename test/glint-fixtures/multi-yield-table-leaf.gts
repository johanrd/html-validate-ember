// Mirrors HdsTable's multi-yield-into-different-native-ancestors
// shape: the addon template renders `<table><thead>...</thead>
// <tbody>{{yield to="body"}}</tbody></table>` with one yield inside
// `<thead>` (named "head") and another inside `<tbody>` (named
// "body"). Each named yield has a DIFFERENT nearest native
// ancestor.
//
// The outer-wrapper-resolver's yield-nearest-ancestor walk picks
// the FIRST yield it finds — `<thead>` here — and dual-tag
// substitution prefers it over the actual outer `<table>`. Result:
// a consumer that uses the `<:body>` block sees its wrapper
// substituted to `<thead>` instead of the runtime DOM's `<table>`,
// FP-firing `element-permitted-content` on whatever the consumer
// nests below.
//
// Fix: when a template has yields in multiple distinct native
// ancestors, the single-yield-ancestor signal is unreliable for
// any one named-block invocation. Bail to the outer wrapper
// (`<table>`), the only tag we know is correct regardless of
// which named block the consumer picks.
import type { TemplateOnlyComponent } from '@ember/component/template-only';

interface MultiYieldTableSig {
  Element: HTMLTableElement;
  Blocks: {
    head: [];
    body: [];
  };
}

const MultiYieldTable: TemplateOnlyComponent<MultiYieldTableSig> = <template>
  <table ...attributes>
    <thead>{{yield to="head"}}</thead>
    <tbody>{{yield to="body"}}</tbody>
  </table>
</template>;

export default MultiYieldTable;
