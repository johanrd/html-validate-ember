// Consumer mirroring HDS's form-layout showcase pattern:
//   <HdsForm as |FORM|>
//     <FORM.Section as |FS|>
//       <FS.Header as |FSH|>
//         <FSH.Title>...</FSH.Title>
// Two nested dotted hops (`FS` ← `FORM.Section`, `FSH` ← `FS.Header`).
// `<FSH.Title>` should resolve through the full chain to the inner
// `CurryInner`'s class-getter default tag ('div'). Without
// multi-level dotted binder lookup, the chain breaks one hop early
// and Glint's TS-side picks the first union-element-type member
// ('h1' from HTMLHeadingElement) for `<FSH.Title>`.
import Outer from './curry-multi-level-outer.gts';

<template>
  <ul>
    <li>
      <Outer as |O|>
        <O.Section as |S|>
          <S.Title>title text</S.Title>
        </O.Section>
      </Outer>
    </li>
  </ul>
</template>
