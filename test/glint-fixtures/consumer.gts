// Imports a typed component from a sibling .gts file. Glint should resolve
// `<TypedButton />` to `<button>` (via Signature['Element'] = HTMLButtonElement)
// even though the type comes from another .gts file.
import Component from '@glimmer/component';
import TypedButton from './typed-button.gts';

export default class Consumer extends Component {
  noop = () => {};

  <template>
    <div>
      <TypedButton @label='Save' @onClick={{this.noop}} />
    </div>
  </template>
}
