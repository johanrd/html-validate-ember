import MyTable from './no-glint-table-component.gts';

// No-Glint regression (validated without Glint — examples/ has no Glint
// tsconfig, so this drives the canonical resolver). The cells are dotted
// `<B.Td>`/`<B.Tr>` inside a `<:body>` named block; the canonical
// resolver returns transparent for them, so the `<div>` blanks up toward
// the `<table>`. element-permitted-content ("<div> not permitted under
// <table>") must NOT fire — at runtime the cells render `<tr>`/`<td>`.
//
// Requires (1) build-maps recording dotted invocations as 'transparent'
// and (2) detectSuppressions descending the `<:body>` named block so
// Case D collects the floating `<div>`.
<template>
  <MyTable>
    <:body as |B|>
      <B.Tr>
        <B.Td><div class="cell">content</div></B.Td>
      </B.Tr>
    </:body>
  </MyTable>
</template>
