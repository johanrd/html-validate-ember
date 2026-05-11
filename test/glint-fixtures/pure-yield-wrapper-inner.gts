// Pure-yield wrapper: template body is JUST `{{yield}}` (no element).
// Mirrors HdsPopoverPrimitive which yields a hash of helpers without
// emitting its own outer element — the consumer's children ARE the
// rendered DOM.
import { hash } from '@ember/helper';
import Component from '@glimmer/component';

interface InnerSig {
  Args: {};
  Blocks: { default: [{ noop: undefined }] };
}

export default class PureYieldInner extends Component<InnerSig> {
  noop = () => {};

  <template>
    {{yield (hash noop=this.noop)}}
  </template>
}
