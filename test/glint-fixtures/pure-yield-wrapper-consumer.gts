// Consumer mirroring HDS's app-header with-nested-content pattern:
// `<SF.Item>` (li) > `<HdsDropdown>` (which uses HdsPopoverPrimitive
// pure-yielder, then internally wraps yielded items in `<ul>`).
// Without pure-yield descent, `<Outer>` resolves to `transparent`
// (because PureYieldInner has only `{{yield}}`), the substitution
// drops the `<ul>` wrapper, and the inner `<li>` items appear as
// siblings of the consumer's outer `<li>` — implicit-close FP.
import Outer from './pure-yield-wrapper-outer.gts';

<template>
  <ul>
    <li>
      <Outer>
        <li>item 1</li>
        <li>item 2</li>
      </Outer>
    </li>
  </ul>
</template>
