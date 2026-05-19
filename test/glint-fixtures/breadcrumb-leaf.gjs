// Issue #33 leaf: outer is <nav>, but {{yield}} sits inside <ol>.
// Consumer-yielded <li> items land inside the <ol> at runtime, so the
// invocation must substitute to the yield-ancestor <ol>, not <nav>.
<template>
  <nav>
    <ol>
      {{yield}}
    </ol>
  </nav>
</template>
