import Component from '@glimmer/component';

// Three decorative-image patterns whose `title` attribute is
// dynamic in a way the blanker can't faithfully model. All three
// should be suppressed by `imgHasDynamicTitle` — no h67 message
// should fire on any of them.
//
//   img 1 — bare-mustache title (`title='{{x}}'`)
//   img 2 — ConcatStatement title with whitespace-only literal
//           parts (`title=' {{x}} '`)
//   img 3 — bare-mustache title inside `{{#if}}` (branch
//           selection picks the arm with the img, and the per-
//           element detection still finds it)
export default class H67ImgDynamicTitlePatterns extends Component<{
  Args: { tip: string; spaced: string; cond?: string };
}> {
  <template>
    <img src='/a.png' alt='' title='{{@tip}}' />
    <img src='/b.png' alt='' title=' {{@spaced}} ' />
    {{#if @cond}}
      <img src='/c.png' alt='' title='{{@cond}}' />
    {{/if}}
  </template>
}
