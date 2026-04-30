// Verifies that static-text resolution (t-helper, if-helper, const lookup)
// does NOT fire on mustaches inside a substituted component's open tag.
// If the guard breaks, "Equipment" / "auto" / "Save" would leak into the
// open-tag area and html-validate's lexer would parse them as attribute
// names, producing attr-case errors.
const POPOVER_MODE = 'auto';

import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    <MyButton @label={{t 'Equipment activity'}} @kind='primary'>
      child content
    </MyButton>

    <CountryCode @mode={{POPOVER_MODE}} />

    <Modal @title={{if this.x 'Save' 'Cancel'}}>
      <p>body</p>
    </Modal>
  </template>
}
