import Component from '@glimmer/component';

class Sized extends Component<{ Args: { size: string; label: string } }> {
  <template><span class={{@size}}>{{@label}}</span></template>
}

export default class LiteralArgSibling extends Component {
  text = 'hello';
  <template>
    <Sized @size={{"lg"}} @label={{this.text}} />
  </template>
}
