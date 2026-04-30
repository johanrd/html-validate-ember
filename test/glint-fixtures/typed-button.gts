// Cross-file fixture: a Button component that declares
// `Signature['Element'] = HTMLButtonElement`. Imported by `consumer.gts`.
import Component from '@glimmer/component';

interface ButtonSig {
  Element: HTMLButtonElement;
  Args: {
    label: string;
    onClick: () => void;
  };
}

export default class TypedButton extends Component<ButtonSig> {
  <template>
    <button type='button' aria-label={{@label}} {{on 'click' @onClick}}>
      icon
    </button>
  </template>
}
