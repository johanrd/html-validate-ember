// Consumer mirroring HDS's form-layout containers shape:
//   <HdsForm as |FORM|>
//     <FORM.HeaderTitle>…</FORM.HeaderTitle>
//     <FORM.HeaderDescription>…</FORM.HeaderDescription>
// The wrapper's template is conditional (form vs div) — outer
// resolves TRANSPARENT. The yielded hash binds two children that
// MUST resolve to DIFFERENT native tags: HeaderTitle to <div>
// (class-getter default forwarded through inner polymorphic) and
// HeaderDescription to <p> (literal `@tag="p"` to inner).
//
// Regression guard: previously the baseline captured FORM.HeaderTitle
// as <h1> (Glint TS-side union pick of HTMLHeadingElement) before
// the polymorphic chain trace landed; once the chain resolves through
// the class getter the title correctly lands on <div>, and the
// description still correctly lands on <p>.
import CondForm from './yield-hash-cond-form.gts';

<template>
  <CondForm as |FORM|>
    <FORM.HeaderTitle>title text</FORM.HeaderTitle>
    <FORM.HeaderDescription>desc text</FORM.HeaderDescription>
  </CondForm>
</template>
