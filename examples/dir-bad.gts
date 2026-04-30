// Trivial fixture: `dir` attribute with an invalid value.
// html-validate's `attribute-allowed-values` rule should fire
// on the line with `dir="bogus"`. Valid: ltr | rtl | auto.
const greeting = "hello";

<template>
  <div dir="bogus">
    {{greeting}}
  </div>
</template>
