// Typed slider component for cross-file extraction tests.
// Splatted root is `<input ...attributes type='range' min='0' max='100' />`
// — the literal `type='range'` should be picked up by
// `extractAttrTypeMap`'s componentAttrMap when this component is
// invoked from another `.gts`.
import Component from '@glimmer/component';

interface LogSliderSig {
  Element: HTMLInputElement;
  Args: {
    value?: number;
  };
}

export default class LogSlider extends Component<LogSliderSig> {
  <template>
    <input
      ...attributes
      type='range'
      min='0'
      max='100'
      step='1'
    />
  </template>
}
