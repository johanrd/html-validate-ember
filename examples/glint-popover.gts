import Component from '@glimmer/component';

interface Sig {
  Args: {
    mode: 'auto' | 'manual' | 'hint';
    label: string;
  };
}

export default class PopoverWidget extends Component<Sig> {
  <template>
    <div popover={{@mode}} aria-label={{@label}}>
      content
    </div>
  </template>
}
