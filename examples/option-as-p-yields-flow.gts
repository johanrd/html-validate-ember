// Mirrors limber's `Option` TOC component shape. The addon's template
// puts `{{yield}}` inside `<p>` (phrasing-content-only). When the
// consumer yields flow content like `<ul>` or `<div>`, the runtime
// DOM browser-implicitly-closes `<p>` before the flow element —
// which is technically a real-world tag-soup issue at the addon
// level, but from the consumer's perspective they're using a
// third-party component and shouldn't be lectured about implicit
// closes.
//
// Pre-rewrite, the addon's Option resolved to 'transparent' (no
// Element type declared) and consumer's `<ul>` floated to the
// outer template root — no FP. The canonical resolver's yield-
// ancestor preference now picks `<p>` (the immediate yield-
// ancestor) over `<div>` (the outer wrapper). The substituted
// `<p>...{ul}...</p>` then trips `no-implicit-close` and
// `close-order`.
//
// Fix: don't pick yield-ancestor when it's a phrasing-only
// element. Outer `<div>` is a safer fallback — flow-accepting,
// no false content-model conflicts when the consumer yields
// flow content.
import type { TOC } from '@ember/component/template-only';

const Option: TOC<{
  Args: { name: string };
  Blocks: { default: [] };
}> = <template>
  <div class="opt">
    <h3>{{@name}}</h3>
    <p>
      {{yield}}
    </p>
  </div>
</template>;

<template>
  <Option @name="@format">
    Available formats:
    <ul>
      <li>gjs</li>
      <li>hbs</li>
    </ul>
  </Option>
</template>
