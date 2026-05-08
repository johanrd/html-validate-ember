// Negative-path fixture: an addon whose `.hbs` root is itself a
// component invocation (PascalCase) — `<AnotherComponent
// ...attributes>{{yield}}</AnotherComponent>`. Without the
// `isNativeTag` guard the resolver would feed `AnotherComponent`
// into `componentTagMap`, and blank.ts's substitution path would
// rename `<ComposedCard>` to `<AnotherComponent>` — producing a
// non-native tag in the validated output and making content-model
// checks worse than the transparent-blanking fallback.
//
// The guard rejects non-native tags: this consumer should NOT see
// `<ComposedCard>` resolve to anything; the entry should be absent
// from `componentTagMap` (or recorded as 'transparent' by the
// caller's fallback path).
import ComposedCard from 'composing-addon/components/composed-card';

<template>
  <div>
    <ComposedCard>x</ComposedCard>
  </div>
</template>
