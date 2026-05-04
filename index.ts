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

// Ember/Glimmer ecosystem style preferences, baked in for projects that
// want their lint to match `ember-template-lint` conventions out of the
// box. Layered on top of TRANSFORMER_ARTIFACT_RULES in `:gts-recommended`.
const EMBER_STYLE_RULES: RuleConfig = {
  // Ember/Glimmer convention is self-closing for void elements (`<input />`,
  // `<br />`, `<img />`). `ember-template-lint`'s `self-closing-void-elements`
  // rule enforces this. html-validate's default is the omitted form
  // (`<input>`), which would fight every Ember template — match the
  // ecosystem default. Rule still fires on style-mixing.
  'void-style': ['error', { style: 'selfclosing' }],
};

const plugin: Plugin = {
  name: 'html-validate-ember',
  transformer: {
    default: transform,
  },
  configs: {
    // Minimal preset: transformer essentials only. Pick this if you want
    // to take all html-validate / project-level defaults and only have
    // this plugin disable the rules that fire on transformer artifacts.
    recommended: {
      elements: ELEMENTS,
      rules: TRANSFORMER_ARTIFACT_RULES,
    },
    // Opinionated preset for Ember/Glimmer projects. Includes everything
    // in `:recommended` plus style preferences that match
    // `ember-template-lint` conventions (self-closing void elements,
    // etc.). Most Ember projects should extend this.
    'gts-recommended': {
      elements: ELEMENTS,
      rules: { ...TRANSFORMER_ARTIFACT_RULES, ...EMBER_STYLE_RULES },
    },
  },
};

export default plugin;
