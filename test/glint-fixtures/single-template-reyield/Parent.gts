// Single-`<template>` file: `findTemplateSource({ declFile, componentName })`
// returns this sole template regardless of the name asked for. The binder
// `<Binder>` is referenced WITHOUT an import (resolved via sibling probe),
// so the same-file decl lookup must NOT self-match this parent and recurse
// to MAX_DEPTH — it must fall through to the sibling `Binder.gts`.
<template>
  <Binder as |F|>
    {{yield (hash Thing=F.Item)}}
  </Binder>
</template>
