import Component from '@glimmer/component';

// Two decorative images in one template:
//
//   Image A — title='{{@tip}}' (dynamic). Runtime title may be empty.
//             h67 fires today (FP). Should be SUPPRESSED.
//
//   Image B — title='Some literal' (static, non-empty). Decorative
//             image (alt='') with a static non-empty title is a
//             real H67 violation. Should STILL FIRE.
//
// Per-element disable scopes the suppression to Image A only; Image
// B's real violation surfaces normally.
export default class MultiImgH67 extends Component<{
  Args: { tip: string };
}> {
  <template>
    <img src='/x.png' alt='' title='{{@tip}}' />
    <img src='/y.png' alt='' title='Some literal' />
  </template>
}
