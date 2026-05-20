import Component from '@glimmer/component';

// <input> with ...attributes — consumer may pass type='submit'
// through the splat. The form has no statically-known submit.
export default class H32InputSplatAttrs extends Component {
  <template>
    <form>
      <input ...attributes value='Go' />
    </form>
  </template>
}
