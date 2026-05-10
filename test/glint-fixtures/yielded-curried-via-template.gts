// Cross-file fixture for the curried-via-yield-hash resolver path.
//
// `WrappedStep` declares the GENERIC `Element: HTMLElement` so Glint's
// TS-level resolution returns 'transparent'. But its `<template>`
// literally renders `<li>`. The canonical resolver follows the parent's
// `{{yield (hash Step=this.WrappedStep)}}` chain → `this.WrappedStep`
// → class assignment to `WrappedStep` → import → renders `<li>`.
//
// This is the HDS pattern (`<HdsStepperList as |S|><S.Step>`) when the
// curried child's signature doesn't pin a specific Element type.
import Component from '@glimmer/component';
import { hash } from '@ember/helper';
import type { TOC } from '@ember/component/template-only';

interface WrappedStepSig {
  // Bare HTMLElement → Glint resolves to 'transparent'. The new
  // resolver bridges this gap by walking the actual template.
  Element: HTMLElement;
  Blocks: { default: [] };
}
const WrappedStep: TOC<WrappedStepSig> = <template>
  <li ...attributes>{{yield}}</li>
</template>;

interface StepperSig {
  Element: HTMLOListElement;
  Blocks: { default: [{ Step: typeof WrappedStep }] };
}
class Stepper extends Component<StepperSig> {
  WrappedStep = WrappedStep;
  <template>
    <ol ...attributes>
      {{yield (hash Step=this.WrappedStep)}}
    </ol>
  </template>
}

<template>
  <Stepper as |S|>
    <S.Step>first</S.Step>
    <S.Step>second</S.Step>
  </Stepper>
</template>
