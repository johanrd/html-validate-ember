// Verifies that {{#if}}/{{else}} doesn't produce duplicate-landmark FPs.
// Both branches contain a <main>; at runtime only one renders. The
// transformer emits only the truthy branch for validation.
import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    {{#if this.loggedIn}}
      <main>
        <h1>Dashboard</h1>
      </main>
    {{else}}
      <main>
        <h1>Sign in</h1>
      </main>
    {{/if}}

    {{!-- else-if chain — all alternate branches must be blanked too --}}
    {{#if this.role}}
      <nav aria-label='admin'>admin nav</nav>
    {{else if this.guest}}
      <nav aria-label='guest'>guest nav</nav>
    {{else}}
      <nav aria-label='other'>other nav</nav>
    {{/if}}
  </template>
}
