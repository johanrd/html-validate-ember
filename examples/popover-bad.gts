// Trivial fixture: popover attribute with an invalid value.
// html-validate's `attribute-allowed-values` rule should fire
// on line 5, column ~16 (the `popover="bogus"` attribute).
const greeting = "hello";

<template>
  <div popover="bogus">
    {{greeting}}
  </div>
</template>
