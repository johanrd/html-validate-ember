// Mirrors HdsFormHeaderDescription: template-only wrapper that
// passes a literal `@tag="p"` through to a polymorphic inner. The
// inner's `(element this.componentTag)` resolves to <p>.
import type { TemplateOnlyComponent } from '@ember/component/template-only';

import ThisPropInner from './this-prop-passthrough-inner-leaf.gts';

interface PDescriptionSig {
  Blocks: { default: [] };
}

const PDescription: TemplateOnlyComponent<PDescriptionSig> =
  <template>
    <ThisPropInner @tag="p" ...attributes>{{yield}}</ThisPropInner>
  </template>;

export default PDescription;
