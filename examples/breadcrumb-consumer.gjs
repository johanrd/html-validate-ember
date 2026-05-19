// Issue #33 consumer: nav > ol > li at runtime. <Breadcrumb> resolves
// to <nav> with yield-ancestor <ol>; <BreadcrumbItem> resolves to <li>.
// The <li> items must be validated against the yield-ancestor <ol>,
// not the outer <nav> — otherwise element-permitted-content /
// element-permitted-parent FP-fire on the invocation.
import Breadcrumb from '../test/glint-fixtures/breadcrumb-leaf';
import BreadcrumbItem from '../test/glint-fixtures/breadcrumb-item-leaf';

<template>
  {{! this structure is nav > ol > li, but it threw element-permitted-* }}
  <Breadcrumb>
    <BreadcrumbItem @href="/">Home</BreadcrumbItem>
  </Breadcrumb>

  {{outlet}}
</template>
