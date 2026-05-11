// Mirrors the unresolvable-yield-chain pattern in HDS's
// `<HdsFormSelectField as |F|><F.Options>...` — a curried sub-
// component (`F.Options`) yielded through multiple levels where the
// final native parent (`<select>`) lives in an inner component's
// template.
//
// To make the FP actually fire here, the outer wrapper has bare
// `Element: HTMLElement` (not a specific tag) so PR #12 resolves it
// as 'transparent'. Then everything floats out: <option> ends up
// directly under <div>, and `element-permitted-content` fires.
//
// Resolving this precisely would require recursive cross-file yield-
// chain analysis (~250+ lines, deferred). The pragmatic fix is
// heuristic suppression: when an unresolvable component invocation
// contains structural children (`<option>`/`<th>`/`<li>`) that would
// be invalid under the actual outer parent, the plugin presumes the
// wrapper is structurally-rendering and suppresses
// `element-permitted-content` for the Source. Same per-Source
// suppression trade-off as Thread B's wcag/h32 fix.
import Component from '@glimmer/component';

interface PassThroughSig {
  Element: HTMLElement;
  Args: Record<string, never>;
  Blocks: { default: [] };
}
class PassThrough extends Component<PassThroughSig> {
  <template>
    {{yield}}
  </template>
}

interface FormSelectFieldSig {
  Args: Record<string, never>;
  Blocks: { default: [{ Options?: typeof PassThrough }] };
  Element: HTMLElement;
}
class FormSelectField extends Component<FormSelectFieldSig> {
  <template>
    {{yield (hash Options=PassThrough)}}
  </template>
}

<template>
  <div>
    <FormSelectField as |F|>
      <F.Options>
        <option value='one'>One</option>
        <option value='two'>Two</option>
      </F.Options>
    </FormSelectField>
  </div>
</template>

const hash = <T,>(o: T): T => o;
