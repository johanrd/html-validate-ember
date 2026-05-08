// Cross-file fixture for classic Ember addon `.hbs` template
// resolution. `fake-card-addon` is a sibling node_modules entry whose
// component lives at `addon/templates/components/fake-card.hbs` — no
// JS-side `Signature['Element']`, no satisfies-TOC. At runtime
// `<FakeCard>` renders `<li>`, so `<li>` inside `<ul>` is legal.
//
// `resolveAddonHbsTemplate` matches the import-path shape
// `<addon>/components/<name>` (or `<addon>/templates/components/<name>`),
// walks up to find `node_modules/<addon>`, probes the canonical Ember
// addon template paths, and parses the root native element via
// `extractSplattedRootFromTemplate`.
import FakeCard from 'fake-card-addon/components/fake-card';

<template>
  <ul>
    <FakeCard>first</FakeCard>
    <FakeCard>second</FakeCard>
  </ul>
</template>
