// Cross-file fixture for block-param-yielded curried sub-components:
// `<SelectBase as |C|><C.Options>...</C.Options></SelectBase>`. The
// parent yields a curried sub-component as a block-param; the
// sub-component's `Signature['Element']` should propagate so that
// children placed inside `<C.Options>` are validated against the
// runtime tag (`<select>`) rather than transparent-blanked.
//
// Glint's `emitComponent(...).element` surfaces the type as `any` for
// this shape, but the componentRef expression itself
// (`resolve(C?.Options)`) carries the type `TOC<OptionsSig>`.
// `resolveElementFromComponentRefType` reads `Element` off
// `aliasTypeArguments[0]` directly.
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
      <option value="a">a</option>
      <option value="b">b</option>
    </C.Options>
  </SelectBase>
</template>
