// Static-text resolution for common Glimmer helpers.
// Each h1/button below would have been "empty" after blanking; with the
// helpers resolved we get real text into html-validate.
import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    <h1>{{t 'Welcome'}}</h1>
    <h2>{{t 'Subtitle of the page'}}</h2>
    <button type="button">{{if this.loading 'Loading' 'Ready'}}</button>
    <p>{{if this.x 'yes' 'no'}}</p>
  </template>
}
