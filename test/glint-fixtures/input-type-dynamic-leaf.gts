// Mirrors HDS's `<HdsFormTextInputBase>` shape: self-closing void
// component whose addon template binds `type` from an arg
// (`<input type={{this.computedType}} ...attributes />`). Chain-attr
// extraction records `type` as the DynamicValue placeholder
// (3-space whitespace) — the marker for "this attr value is
// runtime-dynamic", NOT a literal value the substitution should
// embed.
//
// Without the `isLiteralSafeForAttr` placeholder rejection, the
// chain's placeholder would slip through `isLiteralSafeForAttr`
// (whitespace passes the no-HTML-altering-chars regex) and get
// stored as a "safe literal" — then the hook-time setAttribute
// path passes the literal whitespace string to html-validate,
// which fires `attribute-allowed-values` ("Attribute 'type' has
// invalid value '   '").
//
// The fix: `isLiteralSafeForAttr` rejects the DynamicValue
// placeholder so the substitution falls through to the
// DynamicValue path and `processAttribute` converts it correctly.
import Component from '@glimmer/component';

interface InputDynamicTypeSig {
  Element: HTMLInputElement;
  Args: { kind?: 'text' | 'email' | 'password' };
}

export default class MyDynamicInput extends Component<InputDynamicTypeSig> {
  get computedType(): string {
    return this.args.kind ?? 'text';
  }
  <template>
    <input type={{this.computedType}} ...attributes />
  </template>
}
