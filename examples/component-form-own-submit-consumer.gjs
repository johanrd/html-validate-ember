// Issue #34 consumer: invokes a component that resolves to `<form>`
// and carries its own static submit button. The invocation is
// self-closing, so the consumer contributes no submit child — the
// blanked output is an empty substituted `<form>`. `wcag/h32` must NOT
// fire here: the form's submit is the component's responsibility (and
// is caught if its own file is ever genuinely submit-less).
import FormWithSubmit from '../test/glint-fixtures/component-form-own-submit-leaf';

<template>
  {{! this form has a submit button but the invocation here threw wcag/h32 }}
  <FormWithSubmit />

  {{outlet}}
</template>
