// Consumer with narrow Glimmer-attr slots. Mirrors HDS's
// `<HdsLinkInline @href="#" @color="primary">` pattern: short @args,
// no consumer-side `target`/`rel` (those come from the addon's
// template literally). The chain-attr collection records `target`,
// `rel`, AND `href` from the addon. Slot fitting: `target='_blank'`
// (16 chars) fits in the wider @color slot; `href='   '` (10 chars)
// doesn't fit in `@href="#"` (9 chars); `rel='...'` (29 chars) doesn't
// fit anywhere.
//
// Today this FP-fires `attribute-misuse` ("target requires href")
// because we inject `target` but not `href`. The fix should ensure
// that when `target` (or any href-requiring attr) is injected on a
// substituted `<a>`, `href` is ALSO present — via the source-side
// slot OR the hook-time `setAttribute` fallback.
import MyLink from '../test/glint-fixtures/anchor-target-href-leaf.gts';

<template>
  <MyLink @href="#" @color="primary">
    Click me
  </MyLink>
</template>
