<p align="center">
  <img src="./assets/logo.png" alt="HTML-validate ember" width="480" />
</p>

[HTML-validate](https://html-validate.org) for your Ember templates (`.gts`, `.gjs`, `.hbs`): Run HTML5 spec checks, accessibility rules, content-model rules, and form-correctness rules — with diagnostics pointing at exact source positions.

## Install

`html-validate` is a peer dependency, so install **both**:

```sh
pnpm add --save-dev html-validate html-validate-ember
```

## Configure

Create `.htmlvalidate.json` at your project root:

```json
{
  "extends": ["html-validate:recommended", "html-validate-ember:gts-recommended"],
  "plugins": ["html-validate-ember"],
  "transform": {
    "^.*\\.(gts|gjs|hbs)$": "html-validate-ember"
  }
}
```

### Two presets

Pick whichever fits your project:

- **`html-validate-ember:gts-recommended`** *(recommended for most projects)* — everything in `:recommended` plus Ember/Glimmer style conventions baked in (`void-style: selfclosing` to match `ember-template-lint`'s `self-closing-void-elements`, etc.).
- **`html-validate-ember:recommended`** *(minimal)* — only the rule disables that are *required* for the transformer to behave correctly: `no-trailing-whitespace`, `no-self-closing`, `attr-quotes`, `no-raw-characters`. No stylistic opinions.

## Run

The recommended pattern is to wire the bundled `validate-gts` into `package.json` scripts:

```json
"scripts": {
  "lint:html": "validate-gts app/templates app/components"
}
```

Then:

```sh
pnpm lint:html
```

Wire it into CI alongside your existing lint scripts; non-zero exit fails the build.

For ad-hoc one-off runs, use `pnpm exec`:

```sh
pnpm exec validate-gts app/components/foo.gts            # single file
pnpm exec validate-gts --no-glint app/components/foo.gts # single file no glint
pnpm exec validate-gts app/templates                     # directory (walked recursively)
```

## Progressive enhancement

1. **Bare** (no project config): bundled `:gts-recommended` preset, built-in components (`<Input>` / `<Textarea>` / `<LinkTo>`) substitute to native tags, other components blank transparently as a fallback, static-text resolution via t-helper / if-helper / top-level consts.
2. **+ project `.htmlvalidate.json`**: your rules / extends / transform overrides apply. Bundled CLI loads + merges them.
3. **+ install `@glint/ember-tsc`** (auto-detected, default on; pass `--no-glint` to opt out): `Signature['Element']` resolves component invocations to native tags. Type-narrowed `@arg` values flow into attribute enum checks. Splatted-root literal attributes propagate (e.g. `<MySlider />` substitutes to `<input type='range' min='0' max='100' />` with the actual literal values from the imported component's template).

## What it catches

[html-validate](https://html-validate.org/rules/)'s recommended preset enables 80 rules covering HTML5 content models, ARIA / WCAG, form correctness, and attribute validity.

A few examples — real bugs that ember-template-lint and eslint-plugin-ember don't catch:

### Block element inside a `<p>` silently closes the paragraph

```hbs
<p class='text-sm text-gray-600'>
  Some explanation
  <button>?</button>       
  <div popover>...</div>   {{!-- ← parser auto-closes <p> before the <div> --}}
</p>                       {{!-- ← stray </p>, doesn't match anything --}}
```

```
templates/page.gts:42: error [no-implicit-close] Element <p> is implicitly closed by parent </div>
templates/page.gts:74: error [close-order] Stray end tag '</p>'
```

The browser silently [rewrites the DOM](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/p); your screen-reader tree doesn't match what you wrote.

### Duplicate IDs (cross-component when `@glint/ember-tsc` is installed)

```hbs
<input type='number' name='price' id='price' value='1000' />
<input type='number' name='price' id='price' value='2000' />
```

```
templates/pricing-table.gts:128: error [no-dup-id] Duplicate ID "price"
templates/pricing-table.gts:128: error [form-dup-name] Duplicate form control name "price"
```

### Invalid attribute values

```hbs
<img alt='Logo' width='100px' />   {{!-- ← width must be unitless integer --}}
<input type='checkbox' readonly /> {{!-- ← readonly only valid on text-like inputs --}}
```

```
components/footer.gts:12: error [attribute-allowed-values] Attribute "width" has invalid value "100px"
templates/admin.gts:18: error [input-attributes] Attribute "readonly" not allowed on <input type="checkbox">
```

---

## How this fits in the Ember linting stack

| Tool | Question it answers |
| --- | --- |
| `eslint-plugin-ember` / `ember-template-lint` | Is this idiomatic Ember? Invocation style, reactivity, modifier API, built-in components, plus JS/TS-side rules from eslint-plugin-ember and some overlap of HTML spec and ARIA rules |
| `html-validate-ember` (this plugin) | Is the rendered HTML spec-correct and accessible? — content model, ARIA / WCAG, form correctness, attribute validity, duplicate IDs, unique landmarks. |

See [ECOSYSTEM-OVERLAP.md](https://github.com/johanrd/html-validate-ember/blob/main/ECOSYSTEM-OVERLAP.md)

---

## Inline errors in VS Code

Install the official extension: [html-validate.vscode-html-validate](https://marketplace.visualstudio.com/items?itemName=html-validate.vscode-html-validate).

Add the Ember/Glimmer language IDs to your project's `.vscode/settings.json`:

```json
{
  "html-validate.validate": [
    "html",
    "javascript",
    "markdown",
    "vue",
    "vue-html",
    "glimmer-ts",
    "glimmer-js",
    "handlebars"
  ]
}
```

## Benchmarks

`pnpm bench` runs the mitata benchmarks in `test/validate.bench.mjs`: `extractAttrTypeMap` per fixture, and whole `dist/run.js` runs over `examples/` (cold, warm, one cached file, `--no-glint`). `pnpm bench:compare --base main` runs them against a base branch side by side; CI posts that comparison on pull requests labelled `run-bench`. Deltas under 10 % are within run-to-run noise (🟡); the benchmarks exist to catch order-of-magnitude regressions such as a backend start-up or an uncached per-file cost.

## Glint integration

Install `@glint/ember-tsc` in your project and the transformer extracts TypeScript type information for two patterns. Default on when installed; pass `--no-glint` (or `HVE_GLINT=0`) to opt out.

### TypeScript 7

Type information comes from one of two backends, chosen per `tsconfig.json`:

- **TypeScript 5/6 + `@glint/ember-tsc`** (default). The project's `typescript` is used as a library and Glint's transform rewrites `.gts` files in-process.
- **TypeScript 7** (`typescript/unstable/sync`). Used when the tsconfig declares `contentMappers` (see [ember-content-mapper](https://github.com/NullVoxPopuli/ember-content-mapper)) and a TypeScript 7 package resolves from the project: `typescript` itself when it is 7.x, `@typescript/native-preview`, or the aliases `@typescript/native` / `typescript-7`. The compiler runs the content mapper, so no Glint rewrite and no `typescript` library run in this process. Needs Node 22.12+.

Both produce the same results; the TypeScript 7 backend opens a project once (a few seconds for a large app) and then answers type queries in milliseconds.

- `HVE_TS_BACKEND=tsgo` forces TypeScript 7 (Glint integration is disabled with a message when it is not resolvable); `HVE_TS_BACKEND=ts6` forces the TypeScript 5/6 pipeline.
- `HVE_TSGO=<package name>` names the TypeScript 7 package when it is installed under another alias.

Projects on the TypeScript 5/6 backend that migrated to the content mapper can keep `"ember-source/types"` and `"@glint/ember-tsc/types"` out of `compilerOptions.types`: the backend adds them itself.

### 1. String-literal-union narrowing in attribute positions

```ts
interface PopoverSig {
  Args: { mode: 'auto' | 'manual' | 'hint' }
}

class Popover extends Component<PopoverSig> {
  <template>
    <div popover={{@mode}}>...</div>
  </template>
}
```

Without Glint: `<div popover="">` (DynamicValue, no enum check).
With Glint: html-validate sees `popover="auto"` (or whichever union member is **not** in html-validate's enum, surfacing a typing bug if you've declared an invalid value).

### 2. Component → element substitution

When a component declares `Signature['Element']`, the transformer substitutes the invocation with the corresponding native tag, so content-model rules apply correctly:

```ts
class MyButton extends Component<{
  Element: HTMLButtonElement
  Args: { onClick: () => void }
}> { /* ... */ }
```

```hbs
<MyButton @onClick={{this.foo}} />
```

→ html-validate sees a `<button>`, can apply `no-implicit-button-type` / `text-content` rules accordingly. (The transformer adds DynamicValue placeholders for `type` and label content so those rules don't FP-fire on substituted self-closing components — the actual button has its `type` and label set internally.)

For components with `Element: unknown` (typically yield-only components) the transformer treats the invocation as transparent — children float into the parent's content model.

### Disabling Glint

Glint adds per-file overhead (TS program build, module rewrite, TypeChecker calls). The cache makes repeat runs over unchanged files cheap, but the file you're actively editing pays the cost each iteration. Pass `--no-glint` (or `HVE_GLINT=0`) to skip — you keep built-in component substitution but lose `Signature['Element']` resolution and `@arg` enum narrowing.

### Caching

Glint results are content-addressed and cached on disk under `node_modules/.cache/html-validate-ember/glint/`. Set `HVE_NO_CACHE=1` to bypass the cache.

## Silencing rules

Three layers, broadest to narrowest:

1. **Project config** — disable any rule in `.htmlvalidate.json`:
   ```json
   {
     "rules": {
       "aria-label-misuse": ["error", { "allowAnyNamable": true }],
       "no-inline-style": "off"
     }
   }
   ```

2. **File-level disable** — html-validate directives at the top of a file work normally:
   ```hbs
   {{!-- [html-validate-disable no-dup-id] --}}
   ```

3. **Per-element directive** — Glimmer comment containing the directive:
   ```hbs
   {{!-- [html-validate-disable-next no-dup-id] --}}
   <div id={{this.id}}>x</div>

   {{! [html-validate-disable-next no-dup-id] }}
   <div id={{this.id}}>x</div>
   ```

   **Inline reason / link** — append `-- text` *inside* the brackets (html-validate's directive parser splits on `--` after the rule name):
   ```hbs
   {{!-- [html-validate-disable-next unique-landmark -- pending https://github.com/w3c/html-aria/issues/579] --}}
   <header>...</header>
   ```

   Variants (per html-validate's [inline-config docs](https://html-validate.org/usage/inline-config.html)):
   
<details>
<summary><strong>How positions work</strong></summary>

`content-tag` gives byte offsets for each `<template>` block's content. We compute `line:column` for the block's start, attach as the `Source` base, and emit length-equivalent HTML so byte positions inside the template match positions inside the original `.gts`. html-validate adds reported positions to the base. No SourceMap machinery — same approach `html-validate-vue` and `html-validate-angular` use.

</details>

<details>
<summary><strong>Multipass branch validation</strong></summary>

`{{#if}}/{{else}}` (and `{{else if}}` chains) are validated **per branch by default**. The transformer enumerates branch combinations, yields one html-validate `Source` per combination, and html-validate validates each independently. Errors from every branch surface — including the un-selected branch under single-pass.

Enumeration is capped at the first **10 conditional branches per template** to bound work; "conditional branch" here means any block helper with both a program and an `{{else}}` clause. The common forms are `{{#if/else}}`, `{{#unless/else}}`, and `{{#each/else}}` (empty fallback), but custom block helpers (`{{#my-helper x}}A{{else}}B{{/my-helper}}`) count too. Surplus conditional branches fall back to the single-branch heuristic, which can hide errors in their unselected arms. Override with `--max-conditional-branches=N` on `validate-gts`, or `HVE_MAX_CONDITIONAL_BRANCHES=N` when invoking html-validate directly. Set `N=0` to disable multipass and use the single-branch heuristic everywhere.

Enumeration is **tree-aware**: branches are organized by nesting, and choosing one arm of a branch only enumerates that arm's nested branches. This matches the runtime DOM — choices inside a blanked arm can't affect what html-validate sees — and turns 2^N worst case into far fewer calls on nested templates. A 6-deep `{{#if}}/{{else}}` chain produces 7 distinct passes rather than 64. Pure-sibling branches still scale 2^N, so the cap matters most there.

The bundled `validate-gts` CLI dedupes identical messages by `(line, column, ruleId, message)` before printing, so an error stable across branches (e.g., a misnested element *outside* the if/else) is reported once even though it lives in every pass. The dedupe util is also exported as `dedupeMultipassReport` from `lib/multipass-dedupe.js` for custom consumers.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

- **Static-string scope.** `{{NAME}}` resolves against same-file `const NAME = '...'` declarations and one-level-deep `import { NAME } from './sibling'` (relative paths only — package and path-aliased imports are skipped). `{{this.field}}` resolves against same-file class-field initializers (`field = '...'` or `field: T = '...'`). What's not resolved: transitive re-exports (`export { X } from './...'` chains), default imports, namespace imports, and getters returning literals — Glint narrows some of these to string-literal types when `@glint/ember-tsc` is installed, which the blanker picks up through a separate code path.
- **`no-implicit-button-type` fires on every untyped `<button>`** regardless of `<form>` ancestry — that's html-validate's strict design (default `type=submit` is non-obvious). The plugin doesn't try to soften it; if you'd rather only flag buttons that actually live inside a `<form>` at runtime (where the default-submit matters), disable the rule project-wide and rely on review / a custom lint:
  ```json
  { "rules": { "no-implicit-button-type": "off" } }
  ```

</details>

<details>
<summary><strong>Inspecting what gets emitted</strong></summary>

When debugging a false positive:

```sh
node node_modules/html-validate-ember/dump-blanked.js path/to/file.gts
```

Prints the original `<template>` body and the length-equivalent HTML the transformer hands to html-validate. False positives are usually traceable to the blanker losing or mis-emitting structure.

</details>

## Contributing

PRs welcome. CI runs `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm run typecheck:tests`, and `pnpm test` — mirror those locally.
