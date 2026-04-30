// Headings with mustache-only content. The blanker registers the
// element in `dynamicContentOffsets` so `processElement` appends a
// `DynamicValue` text child, which `html-validate`'s
// `classifyNodeText` then sees as DYNAMIC_TEXT — the `empty-heading`,
// `text-content`, and similar rules all skip dynamic-text elements.
import Component from '@glimmer/component';

export default class T extends Component {
  <template>
    {{!-- Single mustache (resolvable statically by tryStaticText) --}}
    <h1>{{t 'page.title'}}</h1>

    {{!-- Multi-line mustache that DOESN'T statically resolve
          (uses `or` / nested `if` helpers) — exercises the
          dynamicContentOffsets + processElement path. This is the
          shape that recurred in upsert-period.gts:69. --}}
    <h2 class='heading'>
      {{or @title (if (isNode @period) (t 'Edit period') (t 'Add period'))}}
    </h2>

    {{!-- Mixed-content: static text + mustache. --}}
    <h3>Result: {{this.value}}</h3>
  </template>
}
