import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { concat } from '@ember/helper';

// Generated: a large template with nested conditionals and helper calls,
// with a dozen conditionals so multipass enumeration is exercised. Used
// by the benchmarks.
export default class Large extends Component<{ Blocks: { default: [] } }> {
  compact = false;
  title = 'Row';
  placeholder = 'nothing';
  state = 'idle';
  items = [{ active: true, href: '#', label: 'one' }];
  show0 = true; show1 = false; show2 = true; show3 = false; show4 = true; show5 = false; show6 = true;
  select = () => {};

  <template>
    {{#if this.show0}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='0'>
        <h3 title={{concat 'row ' 0}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show1}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='1'>
        <h3 title={{concat 'row ' 1}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show2}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='2'>
        <h3 title={{concat 'row ' 2}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show3}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='3'>
        <h3 title={{concat 'row ' 3}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show4}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='4'>
        <h3 title={{concat 'row ' 4}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show5}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='5'>
        <h3 title={{concat 'row ' 5}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show6}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='6'>
        <h3 title={{concat 'row ' 6}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show0}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='7'>
        <h3 title={{concat 'row ' 7}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show1}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='8'>
        <h3 title={{concat 'row ' 8}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show2}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='9'>
        <h3 title={{concat 'row ' 9}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show3}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='10'>
        <h3 title={{concat 'row ' 10}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
    {{#if this.show4}}
      <section class={{if this.compact 'compact' 'wide'}} data-row='11'>
        <h3 title={{concat 'row ' 11}}>{{this.title}}</h3>
        <ul>
          {{#each this.items as |item|}}
            <li class={{if item.active 'active' 'idle'}}><a href={{item.href}}>{{item.label}}</a></li>
          {{/each}}
        </ul>
        <button type='button' disabled={{eq this.state 'busy'}} {{on 'click' this.select}}>{{yield}}</button>
      </section>
    {{else}}
      <p class='muted'>{{this.placeholder}}</p>
    {{/if}}
  </template>
}
