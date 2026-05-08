// Regression: heuristic suppression must NOT fire when Glint has
// already resolved a curried sub-component to a precise native tag.
//
// `<C.Options>` resolves to `<select>` via PR #18's
// `resolveElementFromComponentRefType` (`aliasTypeArguments[0]['Element']`
// reads `HTMLSelectElement` off `OptionsSig`).
//
// `<th>` is structurally restricted to `<tr>` ancestors — illegal under
// `<select>`. Without correct gating, PR #21's heuristic would over-
// suppress: it sees an unresolvable-looking PascalCase/dotted wrapper
// containing a content-restricted child and disables
// `element-permitted-content` for the whole Source. With correct
// gating, the heuristic checks Glint's resolution first and bails out
// — letting `element-permitted-content` fire on the real bug.
import Component from '@glimmer/component';
import { hash } from '@ember/helper';
import type { TOC } from '@ember/component/template-only';

interface OptionsSig {
  Element: HTMLSelectElement;
  Blocks: { default: [] };
}
const Options: TOC<OptionsSig> = <template>
  <select ...attributes>{{yield}}</select>
</template>;

interface SelectBaseSig {
  Element: HTMLDivElement;
  Blocks: { default: [{ Options: typeof Options }] };
}
class SelectBase extends Component<SelectBaseSig> {
  Options = Options;
  <template>
    <div ...attributes>
      {{yield (hash Options=this.Options)}}
    </div>
  </template>
}

<template>
  <SelectBase as |C|>
    <C.Options>
      <th>not allowed under select</th>
    </C.Options>
  </SelectBase>
</template>
