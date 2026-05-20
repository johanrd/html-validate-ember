// Control case for issue #37. With a literal `<svg>` wrapper in the
// same template, html-validate discards the foreign body wholesale, so
// neither `element-name` nor `element-case` fire on svg-namespace
// children. Contrast with `svg-foreign-content.gts`.
<template>
  <svg viewBox="0 0 100 100">
    <defs>
      <linearGradient id="g">
        <stop offset="0%" stop-color="red" />
        <stop offset="100%" stop-color="blue" />
      </linearGradient>
    </defs>
    <circle cx="50" cy="50" r="40" fill="url(#g)" />
  </svg>
</template>
