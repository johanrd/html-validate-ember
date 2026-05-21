import Component from '@glimmer/component';
import { hash } from '@ember/helper';
import type { TOC } from '@ember/component/template-only';

// The binder's yielded hash entry is driven by an `@arg` (`@elementTag`).
interface BinderSig {
  Element: HTMLElement;
  Args: { elementTag: string };
  Blocks: { default: [{ Item: unknown }] };
}
const Binder: TOC<BinderSig> = <template>{{yield (hash Item=@elementTag)}}</template>;

// The re-yielding component passes that arg from a CLASS GETTER
// (`@elementTag={{this.tag}}`). Resolving `Thing` (re-yielded `F.Item`)
// requires walking `this.tag` to its literal `'section'` so the binder's
// `@elementTag` lookup lands on `<section>` rather than TRANSPARENT.
interface ParentSig {
  Element: HTMLElement;
  Blocks: { default: [{ Thing: unknown }] };
}
class Parent extends Component<ParentSig> {
  get tag(): string {
    return 'section';
  }
  <template>
    <Binder @elementTag={{this.tag}} as |F|>
      {{yield (hash Thing=F.Item)}}
    </Binder>
  </template>
}
