// Reproduces the HDS pagination-table FP cluster:
// `<CodeFragmentWithUserTable />` (a thin wrapper around `<HdsTable>`)
// resolves to `<thead>` because the outer-wrapper-resolver picks the
// FIRST yield it finds inside HdsTable's multi-yield template. The
// substituted `<thead>` then trips `element-permitted-content` under
// any sibling — e.g. `<div><thead></thead></div>` is invalid since
// `<thead>` requires a `<table>` parent.
//
// Pre-dual-tag: outer wrapper `<table>` was used, no FP. Post-dual-
// tag: yield-ancestor `<thead>` "wins" because `<table>` is
// permissive enough that the heuristic prefers the more-restrictive
// yield-ancestor — but the heuristic doesn't consider that the
// template has DIFFERENT yield-ancestors per named block.
import MultiYieldTable from '../test/glint-fixtures/multi-yield-table-leaf.gts';

<template>
  <div>
    <MultiYieldTable />
  </div>
</template>
