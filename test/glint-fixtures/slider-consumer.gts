// Consumer of a cross-file typed slider. The substituted `<input>` should
// inherit the literal `type='range'` from log-slider.gts's splatted root
// (via componentAttrMap), rather than the 3-space placeholder.
import Component from '@glimmer/component';
import LogSlider from './log-slider.gts';

export default class SliderConsumer extends Component {
  noop = () => {};

  <template>
    <div>
      <LogSlider
        @value={{1}}
        id='slider'
        name='count'
        class='w-full'
      />
    </div>
  </template>
}
