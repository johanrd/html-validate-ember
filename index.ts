import type { Plugin, RuleConfig } from 'html-validate';
import svgTags from 'svg-tags';
import { mathmlTagNames } from 'mathml-tag-names';

import transform from './transform.js';

const ELEMENTS = ['html5'];

// Issue #37: html-validate's `<svg>` is `foreign: true` — its parser
// discards the body wholesale, so a literal `<svg>…</svg>` validates
// clean today. But svg/mathml-namespace children that reach the parser
// without an enclosing literal `<svg>` (e.g. fragment in `{{#if}}`,
// fragment yielded into a wrapper whose root the resolver can't pin to
// `<svg>`) get parsed as HTML and trip `element-name` / `element-case`
// as false positives.
//
// Strategy: maintain a canonical-case allowlist of svg/mathml element
// names and, via a parser `tag:start` listener registered in this
// plugin's `setup` hook, call `target.disableRules(['element-name',
// 'element-case'])` for any tag whose source-cased name exactly matches
// the allowlist. Both rules check `target.ruleEnabled(ruleId)` inside
// their `report()` paths, so the disable suppresses emission.
//
// html-validate's engine runs `setupPlugins` before `setupRules`, so
// this listener fires first and the disable lands before either rule's
// callback inspects the node.
//
// Why case-sensitive (no `.toLowerCase()`): SVG is case-sensitive per
// spec — `linearGradient` is the canonical spelling, `<lineargradient>`
// isn't a real SVG element name. By gating on canonical case:
//   - `<linearGradient>`, `<defs>`, `<clipPath>`, …  → silenced
//   - `<lineargradient>` (typo)                      → element-name fires (no hyphen, pattern fails)
//   - `<LinearGradient>` (wrong case)                → both fire
//   - `<dIv>` (miscased HTML)                        → element-case fires
//
// Why no meta-registration: registering svg-tag entries with html-
// validate's `elements` would *also* silence `element-name` via the
// `if (target.meta) return` shortcut in the rule — but the meta lookup
// is case-insensitive (`elements[tagName.toLowerCase()]`, core.js:1283)
// so a lowercased meta key would silence both `<linearGradient>` AND
// `<lineargradient>` indiscriminately, regressing the typo signal.
// Hook-only with a canonical-case gate is the only way to discriminate.
const FOREIGN_NAMES = new Set<string>([...svgTags, ...mathmlTagNames]);

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
  setup(_source, handler) {
    handler.on('tag:start', (_event, data) => {
      if (FOREIGN_NAMES.has(data.target.tagName)) {
        data.target.disableRules(['element-name', 'element-case']);
      }
    });
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
