// Negative-path fixture: import a sibling .gts that doesn't exist. The
// extractAttrTypeMap call should NOT crash — it should resolve as much as
// it can and fall back gracefully for the missing import.
import Component from '@glimmer/component';
import Missing from './does-not-exist.gts';

export default class Broken extends Component {
  <template>
    <div>
      <Missing />
    </div>
  </template>
}
