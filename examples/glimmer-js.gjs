// .gjs fixture (JavaScript flavor of template-imports). Same structure
// as .gts; just no TypeScript. Exercises the same template patterns
// as the .gts comprehensive fixture so we know `.gjs` works the same
// way through the content-tag → blanker pipeline.
import Component from '@glimmer/component';
import { on } from '@ember/modifier';

const TITLE_KEY = 'page.title';

export default class GlimmerJsExample extends Component {
  greeting = 'Hello';

  handleClick = () => {
    this.greeting = 'World';
  };

  <template>
    <main>
      {{!-- Top-level const reference resolves to literal --}}
      <h1>{{t TITLE_KEY}}</h1>

      {{!-- Class field reference (not resolved without Glint) --}}
      <p>{{this.greeting}}</p>

      {{!-- if/else block --}}
      {{#if @loggedIn}}
        <nav aria-label='primary'>
          <a href={{@profileUrl}}>{{t 'nav.profile'}}</a>
        </nav>
      {{else}}
        <a href='/sign-in'>{{t 'nav.sign-in'}}</a>
      {{/if}}

      {{!-- Iteration --}}
      <ul>
        {{#each @items key='id' as |item|}}
          <li>{{item.name}}</li>
        {{/each}}
      </ul>

      {{!-- Component + modifier + splattributes --}}
      <SomeComponent
        @arg={{this.greeting}}
        class='primary'
        ...attributes
      />

      <button
        type='button'
        {{on 'click' this.handleClick}}
        aria-label={{t 'action.toggle'}}
      >
        {{t 'action.label'}}
      </button>
    </main>
  </template>
}
