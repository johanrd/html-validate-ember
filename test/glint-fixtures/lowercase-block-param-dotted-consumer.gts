// Glimmer allows lowercase block-param dotted invocations:
//   <Outer as |o|><o.Section> ... </o.Section></Outer>
// (Ember's convention is PascalCase but the parser doesn't enforce it.)
// Regression guard: buildConsumerInfo's PascalCase gate must NOT skip
// these — the dotted-binding capture has to apply regardless of the
// initial casing as long as the head segment is a block-param in scope.
import Outer from './curry-multi-level-outer.gts';

<template>
  <Outer as |o|>
    <o.Section as |s|>
      <s.Title>title text</s.Title>
    </o.Section>
  </Outer>
</template>
