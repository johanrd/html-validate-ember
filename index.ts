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
// case-folds the key (it does `tagName.toLowerCase()` before indexing
// into the `elements` map), so a lowercased meta key would silence
// both `<linearGradient>` AND `<lineargradient>` indiscriminately,
// regressing the typo signal. Hook-only with a canonical-case gate is
// the only way to discriminate.
const FOREIGN_NAMES = new Set<string>([...svgTags, ...mathmlTagNames]);

// Hoisted: avoids allocating a new array on every `tag:start` event.
const FOREIGN_DISABLED_RULES = ['element-name', 'element-case'] as const;

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
  setup(_source, handler) {
    handler.on('tag:start', (_event, data) => {
      if (FOREIGN_NAMES.has(data.target.tagName)) {
        data.target.disableRules(FOREIGN_DISABLED_RULES);
      }
    });
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
