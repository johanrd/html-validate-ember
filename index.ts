import type { Plugin, RuleConfig } from 'html-validate';

import transform from './transform.js';

// We extend html-validate's html5 element schema as-is. The transformer
// no longer emits any synthetic placeholder element — components without
// a Glint-resolved native tag get their open/close tags blanked entirely,
// so children float to the actual parent for content-model checks.
const ELEMENTS = ['html5'];

// Rules that *must* be disabled for the transformer to behave correctly
// against a typical Ember `.gts` template. These are not stylistic
// choices — they fire on transformer-emission artifacts.
const TRANSFORMER_ARTIFACT_RULES: RuleConfig = {
  // Mustache-only lines blank to whitespace.
  'no-trailing-whitespace': 'off',
  // PascalCase components have their tags blanked transparently —
  // any leftover `/>` in the source span won't reach html-validate as a
  // self-closing native element, but disabling this rule remains safe
  // (some emit paths preserve a self-closing `/>` and we never want to
  // FP-flag it).
  'no-self-closing': 'off',
  // Bare-mustache attribute values are blanked entirely, so the
  // surrounding quote style is no longer reliably preserved. Single-
  // vs double-quote consistency is also a project preference; the
  // transformer can't enforce it faithfully.
  'attr-quotes': 'off',
  // The Glimmer compiler escapes `<`, `>`, and `&` in text content at
  // build time. Source like `<span>Memory > 1000 MB</span>` renders as
  // `Memory &gt; 1000 MB` in the actual DOM — flagging the source is
  // noise, not a real bug.
  'no-raw-characters': 'off',
};

// Stylistic rules from `html-validate:recommended` that fire on
// legitimate Ember/Glimmer code without catching real bugs. Disabled
// here so the lint experience is signal-first ("did I write something
// that breaks at runtime / fails a11y / produces invalid HTML?") rather
// than pedantic-first ("did I follow our preferred attribute style?").
//
// Each entry is a deliberate choice: the rule has a legitimate
// motivation, but its trade-offs in an Ember context tip toward noise.
// Projects that want them back can re-enable per-rule.
const STYLISTIC_NOISE_OFF: RuleConfig = {
  // Bans the `style="..."` attribute. Breaks legitimate runtime
  // style-binding (`<div style={{this.computedStyle}}>`) — a common
  // pattern when computed style depends on component args. Use a
  // separate stylelint pipeline for inline-style policy if needed.
  'no-inline-style': 'off',
  // Insists on either `<input>` (omit) or `<input />` (selfclosing) —
  // never both. html-validate defaults to omit; Ember/Glimmer
  // convention is selfclosing; mixing is harmless. Rather than pick a
  // side and litter every Ember project with violations of the
  // opposite default, disable the rule entirely. (`ember-template-lint`
  // already enforces selfclosing if a project wants that policy.)
  'void-style': 'off',
  // `prefer-native-element` flags `<div role="button">` and similar
  // ARIA-on-generic-element patterns, suggesting the user reach for
  // `<button>` instead. Real a11y signal — but design systems
  // (HDS, ember-primitives, internal libraries) intentionally wrap
  // generic elements with role+keyboard handling when the use case
  // doesn't fit the native semantics. Demote to `warn` so it surfaces
  // in lint output but doesn't fail builds; teams can promote back to
  // `error` per-project if they want that policy.
  'prefer-native-element': 'warn',
};

const plugin: Plugin = {
  name: 'html-validate-ember',
  transformer: {
    default: transform,
  },
  configs: {
    // Recommended preset for Ember/Glimmer projects. Disables:
    //   - rules that fire on transformer-emission artifacts (required
    //     for the plugin to work correctly), and
    //   - stylistic rules from `html-validate:recommended` whose
    //     trade-offs tip toward noise in an Ember codebase.
    // Otherwise inherits `html-validate:recommended` as-is (a11y rules,
    // content-model rules, required-attribute rules, etc.).
    recommended: {
      elements: ELEMENTS,
      rules: { ...TRANSFORMER_ARTIFACT_RULES, ...STYLISTIC_NOISE_OFF },
    },
    // Backwards-compat alias. `:gts-recommended` previously layered
    // Ember-style opinions (self-closing void elements) on top of
    // `:recommended`; those have been folded back out (`void-style` is
    // now off, see STYLISTIC_NOISE_OFF). The two presets are currently
    // identical; the alias stays so existing consumers don't need to
    // edit their `extends`.
    'gts-recommended': {
      elements: ELEMENTS,
      rules: { ...TRANSFORMER_ARTIFACT_RULES, ...STYLISTIC_NOISE_OFF },
    },
  },
};

export default plugin;
