// `<:actions>` lands in a `<td>` and `<:rows>` in a `<tbody>`, so their
// content is valid. `<:caption>` lands directly in the `<table>`, so the
// `<div>` there is a real element-permitted-content error.
import CellYieldTable from '../test/glint-fixtures/cell-yield-table-leaf.gts';

const rows = [{ id: '1', name: 'Excavator' }];

<template>
  <div>
    <CellYieldTable @rows={{rows}}>
      <:caption>
        <div>Not allowed directly in a table</div>
      </:caption>
      <:actions as |row|>
        <span>{{row.name}}</span>
        <button type='button'>Edit</button>
        <div popover id='row-menu'>Menu</div>
      </:actions>
      <:rows>
        <tr>
          <td>Total</td>
          <td></td>
        </tr>
      </:rows>
    </CellYieldTable>
  </div>
</template>
