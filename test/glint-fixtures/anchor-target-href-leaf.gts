// Mirrors HdsLinkInline's external-link branch: an anchor wrapper
// whose addon template has BOTH `target="_blank"` and
// `rel="noopener noreferrer"` LITERAL plus `href={{@href}}` mustache:
//
//   <a target="_blank" rel="noopener noreferrer" ...attributes href={{@href}}>
//     {{yield}}
//   </a>
//
// Chain-attr collection records all three attrs (target+rel literal,
// href DynamicValue). Consumer with narrow Glimmer-attr slots (a few
// short `@arg=` args, no `target` literal) needs all three injected
// into those slots. Today `target` (16 chars `target='_blank'`)
// often fits and gets injected, but `href` (10 chars `href='   '`)
// might not fit (consumer's @href arg slot is `@href="#"` = 9
// chars). Result: substituted `<a target>` without `href` →
// `attribute-misuse` FP-fires.
//
// The principled fix is hook-time `setAttribute` for `<a>`'s `href`
// (same shape as PR #13's `imgSplatSrcOffsets` / PR #21's
// component-substituted-<img> handling). When the addon's chain
// records `href` AND the consumer-side substitution couldn't fit
// it, push the offset; the `processElement` hook calls
// `setAttribute('href', DynamicValue)` at parse time.
import type { TemplateOnlyComponent } from '@ember/component/template-only';

interface MyLinkSig {
  Args: { href: string; color: 'primary' | 'secondary' };
  Element: HTMLAnchorElement;
  Blocks: { default: [] };
}

const MyLink: TemplateOnlyComponent<MyLinkSig> = <template>
  <a target="_blank" rel="noopener noreferrer" ...attributes href={{@href}}>{{yield}}</a>
</template>;

export default MyLink;
