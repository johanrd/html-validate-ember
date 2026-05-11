// Mirrors HdsForm: conditional template (`<form>` vs `<div>` based on
// `@tag`) where BOTH branches yield the same hash of curried/typed
// children. Outer resolves TRANSPARENT (branches disagree on tag).
// The hash yields two entries that resolve to DIFFERENT native tags:
//   HeaderTitle       → <div> (via class-getter default + chain)
//   HeaderDescription → <p>   (via literal `@tag="p"` to polymorphic)
import Component from '@glimmer/component';
import { eq } from 'ember-truth-helpers';
import { hash } from '@ember/helper';

import ThisPropWrapper from './this-prop-passthrough-wrapper-leaf.gts';
import PDescription from './yield-hash-cond-p-description.gts';

interface FormSig {
  Args: { tag?: 'form' | 'div' };
  Blocks: {
    default: [
      {
        HeaderTitle?: typeof ThisPropWrapper;
        HeaderDescription?: typeof PDescription;
      },
    ];
  };
  Element: HTMLFormElement | HTMLDivElement;
}

export default class CondForm extends Component<FormSig> {
  get tag(): 'form' | 'div' {
    const { tag = 'form' } = this.args;
    return tag;
  }

  <template>
    {{#if (eq this.tag "form")}}
      <form ...attributes>
        {{yield
          (hash HeaderTitle=ThisPropWrapper HeaderDescription=PDescription)
        }}
      </form>
    {{else}}
      <div ...attributes>
        {{yield
          (hash HeaderTitle=ThisPropWrapper HeaderDescription=PDescription)
        }}
      </div>
    {{/if}}
  </template>
}
