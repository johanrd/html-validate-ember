// Documents a trade-off: the per-Source `element-permitted-content`
// heuristic suppression (PR #21) masks REAL `element-permitted-content`
// violations in OTHER parts of the same template. Same trade-off shape
// as PR #17's wcag/h32 suppression for input-driven forms.
//
// This template has:
//   1. An unresolvable wrapper with structural children (triggers
//      suppression — fine, FP avoidance).
//   2. A genuine spec violation elsewhere (`<p><div></div></p>` —
//      `<p>` is phrasing content, can't contain `<div>`). With the
//      whole-Source suppression, html-validate's
//      `element-permitted-content` doesn't fire on this either.
//
// The accompanying test in `test/integration.test.ts` is marked
// `it.fails(...)` — it asserts the real bug fires, and when (if) we
// ever implement multi-level yield-chain analysis, the heuristic
// suppression will narrow / disappear, the real bug will surface,
// and vitest will signal "remove .fails — your fix worked".
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
    {{! 1. Heuristic-suppression target (curried sub-component
         containing <option> children — wrapper presumed to render
         <select> via yield chain). }}
    <FormSelectField as |F|>
      <F.Options>
        <option value='one'>One</option>
      </F.Options>
    </FormSelectField>

    {{! 2. Genuine spec violation: <p> is phrasing content, can't
         contain <div>. html-validate would normally flag this — but
         our heuristic disables `element-permitted-content` for the
         whole Source, masking it. }}
    <p>
      <div>this should fire element-permitted-content but doesn't</div>
    </p>
  </div>
</template>

const hash = <T,>(o: T): T => o;
