// Mirrors a 2-level form wrapper pattern: this consumer is ITSELF
// a yield-bearing component whose template is `<MyForm>{{yield}}</MyForm>`,
// where `<MyForm>` substitutes to `<form>` via Glint resolution.
// The static blanker sees `<form>{{yield}}</form>`-shape (after
// substitution) — wcag/h32 fires unless `disableForRules` includes
// the rule.
//
// Pre-fd7fb2a: the heuristic checked `stmt.tag === 'form'` —
// missed `<MyForm>` because its tag is `MyForm`. wcag/h32 FP-fired.
// Post-fd7fb2a: heuristic checks `stmtResolved` (Glint-resolved
// tag), so `<MyForm>` resolves to `form` and the suppression fires.
import type { TemplateOnlyComponent } from '@ember/component/template-only';
import MyForm from '../test/glint-fixtures/glint-resolved-form-leaf.gts';

interface YieldThroughFormSig {
  Element: HTMLFormElement;
  Blocks: { default: [] };
}

const YieldThroughForm: TemplateOnlyComponent<YieldThroughFormSig> = <template>
  <MyForm>{{yield}}</MyForm>
</template>;

export default YieldThroughForm;
