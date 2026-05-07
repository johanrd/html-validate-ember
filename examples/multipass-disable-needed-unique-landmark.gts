// Regression for the multipass `no-unused-disable` catch-22 — same
// shape as `multipass-disable-needed-in-some-branch.gts` but with
// `unique-landmark` standing in for `wcag/h32`. Mirrors the layout in
// link-digital-equipment-to-equipment.gts: two <header>s, each in its
// own if/else, with a disable-next on one of them.
//
//   - In the (a=program, b=program) combination both <header>s exist;
//     the unlabeled one fires `unique-landmark` (empty accessible name
//     against the role group of size 2), and the directive correctly
//     suppresses it.
//   - In the (a=program, b=inverse) combination only the unlabeled
//     <header> exists; the role group has 1 node so `unique-landmark`
//     doesn't fire — and `no-unused-disable` would otherwise fire on
//     the directive comment.
//
// Naive multipass dedupe surfaces `no-unused-disable` from the second
// pass; the user can neither keep nor remove the directive. The fix
// is to disable `no-unused-disable` at transform-time for branched
// Sources (via an injected directive prefix), so this case works
// without depending on report-side dedupe to drop the "unused" report
// from another pass.
import Component from '@glimmer/component';

export default class Demo extends Component {
  get a() {
    return false;
  }

  get b() {
    return false;
  }

  <template>
    {{#if this.a}}
      {{!-- [html-validate-disable-next unique-landmark -- needed when both branches truthy] --}}
      <header>outer banner without an accessible name</header>
    {{else}}
      <p>placeholder</p>
    {{/if}}

    {{#if this.b}}
      <header aria-label='conditional'>only present in some branches</header>
    {{else}}
      <p>placeholder</p>
    {{/if}}
  </template>
}
