import Component from '@glimmer/component';

// Regression: <div> (flow content) inside <span> (phrasing-only) is
// invalid HTML. fix/38 unmasked this pattern by migrating element-
// permitted-content from file-level to per-element disable; any
// future over-broadening of wrapper suppression must continue to
// allow this rule to fire here.
export default class RegressionDivInsideSpan extends Component {
  <template>
    <span>
      text content
      <div>block</div>
      more text
    </span>
  </template>
}
