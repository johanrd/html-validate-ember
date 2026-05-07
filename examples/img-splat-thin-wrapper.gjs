// Thin <img> wrapper: parent provides src + alt via `...attributes`.
// Mirrors the super-rentals `rental/image.gjs` pattern that surfaced
// the narrow-slot FP — a single `...attributes` slot can't fit two
// 9-char `attr='   '` placeholders, so prior versions only synthesized
// `src` source-side and wcag/h37 / element-required-attributes (alt)
// FP-fired. The hook-time injection sidesteps the slot-width problem.
import Component from '@glimmer/component';

export default class ThinImg extends Component {
  <template>
    <img ...attributes>
  </template>
}
