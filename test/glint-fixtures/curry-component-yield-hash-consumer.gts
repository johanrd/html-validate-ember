// Consumer pattern from HDS's form-layout showcase:
//   <ul><HdsForm as |FORM|><FORM.Section as |FS|><FS.Header as |FSH|>
//     <FSH.Title>…</FSH.Title>...
// `<FSH.Title>` resolves to `(component HdsFormHeaderTitle size="300")`
// yielded from a curried hash. The currying doesn't override `@tag`,
// so the inner's `tag` getter returns its default 'div'. Without
// `resolveBinding` handling `SubExpression(component …)`, the canonical
// resolver bails to transparent and Glint's TS-side union pick lands
// on the first union member (here <h1>), reintroducing
// element-permitted-content FPs on legal `<div>`-child content.
import CurryParent from './curry-component-yield-hash-parent.gts';

<template>
  <ul>
    <li>
      <CurryParent as |P|>
        <P.Title>title text</P.Title>
      </CurryParent>
    </li>
  </ul>
</template>
