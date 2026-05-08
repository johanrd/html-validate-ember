// Fieldset with multipass branching: program arm yields, inverse arm
// renders a component. Mirrors the ember-primitives `one-time-password/
// input.gts` pattern surfaced by ecosystem CI.
//
// In the inverse pass the walker sees the curried `<CurriedFields />`
// (component invocation, not a native tag), no static `<legend>`, no
// literal `{{yield}}`. The previous rule was "yield + no static legend
// → suppress wcag/h71"; that misses cases where the rendered content
// is a component which MAY render its own legend at runtime.
//
// Treat any non-native tag (PascalCase / dotted) as opaque content that
// could provide the legend; suppress wcag/h71 unless we see a literal
// `<legend>` statically. Trade-off: a fieldset with only an unrelated
// component child (no legend, no yield) gets suppressed too, even when
// the component truly doesn't render a legend. We err toward
// suppression to avoid the linter-ceremony cascade — the rule still
// fires on any fieldset whose content is purely native HTML with no
// legend.
import Component from '@glimmer/component';

interface FieldsSig {
  Element: HTMLDivElement;
  Args: Record<string, never>;
  Blocks: { default: [] };
}

class CurriedFields extends Component<FieldsSig> {
  <template>
    <div ...attributes>{{yield}}</div>
  </template>
}

interface Sig {
  Element: HTMLFieldSetElement;
  Args: Record<string, never>;
  Blocks: { default: [{ Fields: typeof CurriedFields }] };
}

export default class FieldsetWithComponentContent extends Component<Sig> {
  <template>
    <fieldset ...attributes>
      {{#if (has-block)}}
        {{yield (hash Fields=CurriedFields)}}
      {{else}}
        <CurriedFields />
      {{/if}}
    </fieldset>
  </template>
}

const hash = <T,>(o: T): T => o;
