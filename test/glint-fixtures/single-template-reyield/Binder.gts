import Sec from './Sec.gts';

// Single-`<template>` binder, resolved via sibling probe from Parent.gts.
// Its `Item` re-yields the imported `<Sec>` (→ `<section>`).
<template>{{yield (hash Item=Sec)}}</template>
