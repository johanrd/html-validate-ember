// Consumer of `<Wrapper>` from a multi-template file. Wrapper is
// the SECOND `<template>` block in its source file (Live is first).
// Resolving Wrapper via the leaf-fallback path (line 1103 in
// `glint.ts`) used to pick `roots[0]` = Live's `<span>` —
// surfacing the wrong tag and tripping FPs downstream.
//
// With the fix, multi-template files skip the leaf-fallback;
// Wrapper stays as the underlying Glint Element type (or
// 'transparent' for an unknown signature).
import { Wrapper } from '../test/glint-fixtures/multi-template-file-leaf.gts';

<template>
  <ul>
    <Wrapper>content</Wrapper>
  </ul>
</template>
