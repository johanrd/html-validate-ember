# Changelog

## Release (2026-05-04)

* html-validate-ember 0.2.1 (patch)

#### :bug: Bug Fix
* `html-validate-ember`
  * [#3](https://github.com/johanrd/html-validate-ember/pull/3) fix multi pass false positives in opaque branches and no-unused-disable ([@johanrd](https://github.com/johanrd))

#### Committers: 1
- Johan Røed ([@johanrd](https://github.com/johanrd))

## Release (2026-04-30)

* html-validate-ember 0.2.0 (minor)

#### :rocket: Enhancement
* `html-validate-ember`
  * [#2](https://github.com/johanrd/html-validate-ember/pull/2) Implements multipass validation for {{#if}}/{{else}} ([@johanrd](https://github.com/johanrd))

#### Committers: 1
- Johan Røed ([@johanrd](https://github.com/johanrd))

All notable changes to this project follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/).

## [0.1.0] - 2026-04-30

Initial public release.

### Features

- **html-validate transformer for Ember Glimmer templates** — supports `.gts` (template-imports + TypeScript), `.gjs` (template-imports + JavaScript), and classic `.hbs`. Templates are walked via `@glimmer/syntax` and rewritten to length-preserved HTML so html-validate's reported positions point at exact source offsets.
- **Static-text resolution** — `{{t 'Key'}}`, `{{if cond 'a' 'b'}}`, top-level `const NAME = '...'` (same-file or imported via relative `import { NAME } from './sibling'`), and `{{this.field}}` (against same-file class-field initializers) all resolve into the emitted HTML so html-validate's enum / accessible-text / attribute-allowed-values rules apply on real values rather than placeholders.
- **TS-flavored block-param types are pre-stripped** — `{{#each items as |item: T, idx: number|}}` and similar are normalized to whitespace before Glimmer parses, so the body is no longer silently skipped. Balanced-bracket scanning handles unions (`A | B`), object types (`{ a: number }`), parenthesized types (`(A | B)[]`), generics (`Map<string, number>`), arrays (`T[]`), and qualified names (`NS.Type`).
- **Optional Glint integration** (`--glint`, requires `@glint/ember-tsc` in the host project):
  - Component → element substitution via `Signature['Element']` (e.g. `<MyButton />` → `<button>` for content-model rules).
  - Transparent treatment for `Element: unknown` / yields-only components — children float into the parent's content model.
  - Attribute-value type narrowing — `<div popover={{@mode}}>` with `@mode: 'auto' | 'manual' | 'hint'` flows the literal-union into html-validate's enum check; surfaces a union member NOT in the enum if any (revealing typing bugs).
  - Splatted-root literal extraction — a component whose template root is `<input ...attributes type='range' min='0' max='100' />` propagates those literals to the parent invocation.
  - Cross-file `.gts` resolution — components imported from sibling `.gts` files resolve their `Signature['Element']` end-to-end.
- **Built-in Ember component map** — `<Input>` / `<Textarea>` / `<LinkTo>` substitute to their rendered native tags (`<input>` / `<textarea>` / `<a>`) even without Glint, so content-model rules apply in `.hbs` projects too.
- **Cross-realm `DynamicValue` compatibility** — works under both ESM and CJS html-validate consumers (CLI vs. VS Code extension) by patching `Symbol.hasInstance` on both realm classes. Without this, dynamic content silently triggers `empty-heading` / `text-content` FPs in the VS Code extension while the CLI is clean.
- **Disk cache for Glint extractions** under `node_modules/.cache/html-validate-ember/glint/` — one entry per source file (path-keyed); stored SHAs (file content + tsconfig + plugin version) validated on read; edits overwrite the file's single entry. Plugin upgrades invalidate naturally. Bypass with `HVE_NO_CACHE=1`.
- **`{{#if}}/{{else}}` multipass branch validation** (default; `HVE_MULTIPASS=0` to disable). Each branch combination is validated independently as its own html-validate `Source`. The bundled `validate-gts` CLI dedupes identical messages by `(line, column, ruleId, message)`; the helper is exported as `dedupeMultipassReport` for custom consumers. Capped at 2³ = 8 combinations per template; surplus branch points fall back to the form-submit-aware single-branch heuristic.
- **Glimmer comment directives** — `{{!-- [html-validate-disable rule] --}}` rewrites to `<!-- ... -->` length-preserved so html-validate's directive parser sees them. Long-form `{{!-- --}}` only (short-form `{{! }}` is too short to fit `<!-- -->`).
- **Two presets** — `:gts-recommended` (Ember/Glimmer style + transformer essentials, recommended for most projects) and `:recommended` (transformer essentials only).
- **Bundled CLI** (`validate-gts`) with TTY-aware progress feedback during Glint preload (rewrite + program build) and per-file validation (`--quiet` mode). Loads `.htmlvalidate.json` from the project root and merges with the plugin's programmatic config.
- **Test suite** — 100 unit + integration tests (Vitest); CI runs Node 22 / 24 plus a smoke loop across all shipped fixtures.
- **Authored in TypeScript.** Source ships compiled to `dist/` with `.d.ts` declarations alongside `.js`. Strict mode (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) enforced. Minimal-shape local interfaces stand in for the optional `@glint/ember-tsc` peer dep so its types don't leak into shipped declarations.
