// Verifies that `{{NAME}}` resolves against an `import { NAME } from
// './sibling';` statement — not just same-file `const NAME = '...'`.
//
// `ROUTE_DIR` is `'bogus'` in `./imported-routes.ts`. With cross-file
// resolution working, the blanker substitutes the literal value into
// `<p dir={{ROUTE_DIR}}>` and html-validate's `attribute-allowed-values`
// rule fires (`dir`'s enum is ltr/rtl/auto). Without it, the mustache
// becomes DynamicValue and no enum check happens.
import { ROUTE_DIR } from './imported-routes.ts';

<template>
  <p dir={{ROUTE_DIR}}>x</p>
</template>
