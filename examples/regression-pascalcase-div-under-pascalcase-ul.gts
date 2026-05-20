import Component from '@glimmer/component';

// Regression: a non-native wrapper that Glint-resolves to <ul> and
// renders just `<ul>{{yield}}</ul>` IS the runtime parent of its
// projected children. A child that resolves to <div> ends up at
// runtime as `<ul><div></ul>` — invalid HTML. fix/38 unmasked this
// pattern by migrating element-permitted-content from file-level to
// per-element disable; any future broadening of "non-native wrapper
// + non-native child → suppress" detection must keep this real-bug
// pattern firing. (See the reverted extension attempt during fix/38
// development that masked this case.)
interface MyListSignature {
  Element: HTMLUListElement;
  Blocks: { default: [] };
}
class MyList extends Component<MyListSignature> {
  <template>
    <ul>{{yield}}</ul>
  </template>
}

class MyPlaceholder extends Component<{ Element: HTMLDivElement }> {
  <template>
    <div>placeholder</div>
  </template>
}

export default class RegressionPascalcaseDivUnderPascalcaseUl extends Component {
  <template>
    <MyList>
      <MyPlaceholder />
    </MyList>
  </template>
}
