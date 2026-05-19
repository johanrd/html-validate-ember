{{! Issue #34 leaf: a component whose template IS a `<form>` with its
    own static `<button type="submit">`. When invoked self-closing at a
    consumer, the resolver substitutes only the root `<form>` tag — the
    submit button lives here, not at the call site — so the consumer's
    blanked output is an empty `<form>` and `wcag/h32` FP-fires there
    unless `detectStructuralYieldRules` suppresses it. }}
<template>
  <form>
    <label for="foo">Foo</label>
    <input type="text" name="foo" id="foo" />

    <button type="submit">Submit</button>
  </form>
</template>
