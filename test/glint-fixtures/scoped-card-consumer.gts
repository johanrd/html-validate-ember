// Cross-file fixture exercising two additional dimensions of the
// classic addon `.hbs` resolver:
//   1. SCOPED package name (`@scope/foo-addon`) — the regex must accept
//      `@org/pkg/...` and the dir-walk must locate
//      `node_modules/@scope/foo-addon`.
//   2. `templates/components/<name>` form in the IMPORT path (the other
//      regex branch beyond the unscoped `components/<name>` shape that
//      `fake-card-consumer.gts` covers).
//   3. `app/components/<name>.hbs` as the LOOKUP path inside the addon
//      (the second of the three probed paths; previous fixture used the
//      first one, `addon/templates/components/<name>.hbs`).
import ScopedCard from '@scope/foo-addon/templates/components/scoped-card';

<template>
  <main>
    <ScopedCard>first</ScopedCard>
    <ScopedCard>second</ScopedCard>
  </main>
</template>
