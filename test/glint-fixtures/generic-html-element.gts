// Cross-file fixture: a component declaring `Signature['Element'] =
// HTMLElement` (the generic base, not a specific subclass). Our
// inverted HTMLElementTagNameMap had `'HTMLElement' → 'abbr'` (the
// first tag in lib.dom.d.ts mapping to bare HTMLElement), so this
// shape used to be Glint-resolved to <abbr> and FP-fire
// element-permitted-content downstream.
//
// Surfaced by ecosystem CI on ember-power-select (1) and HDS (multiple).
// The component should fall through to *transparent* — children float
// to the actual parent — rather than be force-tagged as <abbr>.
import Component from '@glimmer/component';

interface GenericSig {
  Element: HTMLElement;
}

export default class GenericHtmlElement extends Component<GenericSig> {
  <template>
    <div>{{yield}}</div>
  </template>
}
