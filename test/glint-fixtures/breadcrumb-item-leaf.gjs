// Issue #33 leaf: a breadcrumb item whose outer is <li>.
<template>
  <li>
    <a href="{{@href}}">
      {{yield}}
    </a>
  </li>
</template>
