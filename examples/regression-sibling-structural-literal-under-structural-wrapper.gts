import Component from '@glimmer/component';

// Regression: a structural-content-parent wrapper has BOTH a
// transparent dotted curried child AND a sibling structural-child
// literal that's a real-bug shape. The suppression must scope to
// the dotted child's subtree only — the unrelated sibling literal
// must still fire `element-permitted-content`.
//
// `<select>` permits `<option>` / `<optgroup>` only. A literal
// `<tr>` directly under `<select>` is a real bug regardless of any
// sibling curried-yield-hash component.
interface MyOptionSignature {
  Element: HTMLOptionElement;
  Blocks: { default: [] };
}

class MyOption extends Component<MyOptionSignature> {
  <template>
    <option>{{yield}}</option>
  </template>
}

export default class RegressionSiblingStructuralLiteral extends Component {
  <template>
    <select>
      <MyOption>one</MyOption>
      <tr>real bug — &lt;tr&gt; not permitted under &lt;select&gt;</tr>
    </select>
  </template>
}
