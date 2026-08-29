import Component from '@glimmer/component';
import Mid from 'app/components/mid';
import LeafTwo from './leaf-two.js';
import fromDir from './dir';
import type { Operations } from 'operations';
import pkg from 'some-pkg';
import 'side-effect-only';

export default class Root extends Component {
  <template><Mid /><LeafTwo /></template>
}
