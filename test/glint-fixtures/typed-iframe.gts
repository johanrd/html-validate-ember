// Cross-file fixture: an `<iframe>` wrapper that gets its required
// `title` attribute from a typed `@label` arg, not a literal. Mirrors
// HDS's `<ShwFrame @label="..." @src="...">` pattern, where the
// `<iframe title=...>` is set from the consumer-passed @label.
import Component from '@glimmer/component';

interface FrameSig {
  Element: HTMLIFrameElement;
  Args: { label: string; src: string };
}

export default class TypedFrame extends Component<FrameSig> {
  <template>
    <iframe ...attributes title={{@label}} src={{@src}} />
  </template>
}
