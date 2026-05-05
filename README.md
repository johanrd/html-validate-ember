<p align="center">
  <img src="./assets/logo.png" alt="HTML-validate ember" width="480" />
</p>

[HTML-validate](https://html-validate.org) transformer for Ember templates — `.gts`, `.gjs`, and classic `.hbs`.

Lint your templates against html-validate's HTML5 spec checks, accessibility rules, content-model rules, and form-correctness rules — with diagnostics pointing at exact source positions.

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

- **`html-validate-ember:gts-recommended`** *(recommended for most projects)* — everything in `:recommended` plus Ember/Glimmer style conventions baked in (`void-style: selfclosing` to match `ember-template-lint`'s `self-closing-void-elements`, etc.). Use this if you want the plugin to "just work" the way an Ember dev expects.
- **`html-validate-ember:recommended`** *(minimal)* — only the rule disables that are *required* for the transformer to behave correctly: `no-trailing-whitespace` (mustache lines blank to whitespace), `no-self-closing` (some emit paths preserve a self-closing `/>`), `attr-quotes` (rewritten attributes use double quotes). No stylistic opinions. Pick this if you'd rather keep all html-validate defaults and only opt into the transformer essentials.

## Run

The bundled `validate-gts` CLI accepts any mix of `.gts` / `.gjs` / `.hbs` files and directories. Directories are walked recursively. Exits non-zero when any file has errors.

The recommended pattern is to wire it into `package.json` scripts:

```json
"scripts": {
  "lint:html:templates": "validate-gts --glint app/templates",
  "lint:html:components": "validate-gts --glint app/components",
  "lint:html": "validate-gts --glint app/templates app/components"
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
pnpm exec validate-gts app/templates                     # directory (walked recursively)
pnpm exec validate-gts --glint app/templates             # enable Glint type extraction
pnpm exec validate-gts --quiet app                       # only show summary
```


## Supported formats

| Format | What it is | Glint integration |
|---|---|---|
| `.gts` | Template-imports + TypeScript (Ember's modern default) | ✅ full (component → element resolution, attribute type narrowing, splatted-root literal extraction) |
| `.gjs` | Template-imports + JavaScript | ✅ same machinery as `.gts` (Glint understands both) |
| `.hbs` | Classic separate template file | ⚠️ no Glint integration. Built-in Ember components (`<Input>`/`<Textarea>`/`<LinkTo>`) substitute to their rendered native tag (`<input>`/`<textarea>`/`<a>`) so content-model rules apply; other components blank transparently (open/close tags removed; children float into the parent's content model). Static-text resolution applies (`{{t 'Key'}}`, `{{if cond 'a' 'b'}}`). |


## Progressive enhancement

The plugin works at every level — opt in to more accuracy as your project's typing investment grows:

1. **Bare** (no project config, no `--glint`): bundled `:gts-recommended` preset, components blank transparently (children float into the parent's content model), static-text resolution via t-helper / if-helper / top-level consts.
2. **+ project `.htmlvalidate.json`**: your rules / extends / transform overrides apply. Bundled CLI loads + merges them.
3. **+ `--glint`** (requires `@glint/ember-tsc` installed): `Signature['Element']` resolves component invocations to native tags. Type-narrowed `@arg` values flow into attribute enum checks. Splatted-root literal attributes propagate (e.g. `<MySlider />` substitutes to `<input type='range' min='0' max='100' />` with the actual literal values from the imported component's template).

Glint silently no-ops when `@glint/ember-tsc` isn't installed, so you can flip `--glint` on and off without breaking anything.

## What it catches

These are real bugs found in a 300-file Ember codebase that **ember-template-lint** and **eslint-plugin-ember** don't catch. They're HTML5 spec / a11y issues, not Ember/Glimmer-specific patterns.

### Block element inside a `<p>` silently closes the paragraph

```hbs
<p class='text-sm text-gray-600'>
  Some explanation
  <button>?</button>
  <div popover>...</div>   {{!-- ← parser auto-closes <p> here --}}
</p>                        {{!-- ← stray </p>, doesn't match anything --}}
```

```
templates/page.gts:42: error [no-implicit-close] Element <p> is implicitly closed by parent </div>
templates/page.gts:74: error [close-order] Stray end tag '</p>'
```

The browser silently rewrites the DOM; your screen-reader tree doesn't match what you wrote.

### Hardcoded duplicate IDs across copy-pasted form rows

```hbs
<td>
  <input type='number' name='price' id='price' value='1000' />  {{!-- 1× --}}
</td>
<td>
  <input type='number' name='price' id='price' value='2000' />  {{!-- 2× --}}
</td>
{{!-- 6 more identical rows --}}
```

```
templates/pricing-table.gts:128: error [no-dup-id] Duplicate ID "price"
templates/pricing-table.gts:128: error [form-dup-name] Duplicate form control name "price"
…16 more
```

The author copy-pasted a pricing-tier column without parameterizing the id. `aria-describedby="price-currency"` resolves to whichever DOM node the browser sees first.

### `<menu>` used as a styled sidebar

```hbs
<menu class='shadow-md flex flex-col px-4 ...'>
  <div>...</div>
  <input type='search' />
  <DatePicker />
</menu>
```

```
templates/sidebar.gts:18: error [element-permitted-content] <div> not permitted under <menu>
templates/sidebar.gts:23: error [element-permitted-content] <input> not permitted under <menu>
```

`<menu>` only accepts `<li>` per HTML5. Catches a common pattern of using `<menu role='menu'>` for popovers/sidebars (~50 sites in the audited app).

### Block element inside phrasing parents

```hbs
<span class='flex gap-2'>
  <p class='rounded-full ...'>Automatisert</p>   {{!-- ← <p> is flow content --}}
</span>

<button>
  <div class='truncate'>Daily total</div>  {{!-- ← <div> is flow content --}}
  <div class='font-semibold'>...</div>
</button>

<h1>
  <div class='skeleton'></div>                   {{!-- ← <div> is flow content --}}
</h1>

<label for='X'>
  <div>Label text</div>                          {{!-- ← <div> is flow content --}}
</label>
```

```
templates/page.gts:88: error [element-permitted-content] <p> not permitted under <span>
components/tile.gts:41: error [element-permitted-content] <div> not permitted under <button>
templates/page.gts:14: error [element-permitted-content] <div> not permitted under <h1>
components/dialog.gts:32: error [element-permitted-content] <div> not permitted under <label>
```

Replace inner `<div>`/`<p>` with `<span class='block'>` — keeps Tailwind classes, fixes the spec violation.

### `<dt>` / `<dd>` outside `<dl>`, or `<dl>` nested in `<dl>`

```hbs
{{!-- Used as a key/value row inside <details><summary>: --}}
<details>
  <summary>
    <div class='flex justify-between'>
      <dt>Total</dt>             {{!-- ← needs <dl> ancestor --}}
      <dd>1,234</dd>             {{!-- ← needs <dl> ancestor --}}
    </div>
  </summary>
</details>

{{!-- Or nested incorrectly: --}}
<dl>
  <dt>{{row.key}}</dt>
  <dl>{{row.value}}</dl>         {{!-- ← author meant <dd> --}}
</dl>
```

```
components/details-row.gts:22: error [element-required-ancestor] <dt> requires "dl > dt" ancestor
templates/item-detail.gts:104: error [element-permitted-content] <dl> not permitted under <dl>
```

### Icon-only `<button>` without an accessible name

```hbs
<button type='button' commandfor='Modal' command='close'>
  <svg>...</svg>   {{!-- ← screen readers announce "button" --}}
</button>
```

```
templates/item-detail.gts:188: error [text-content] <button> must have accessible text
```

Add `aria-label='Close'` (or use the `<button title='...'>` "subjective" form — html-validate flags `title` as discouraged but accepts it).

### `<form>` missing a submit button

```hbs
<form {{on 'submit' this.handleSubmit}}>
  <textarea name='message'></textarea>
  <button type='button'>Cancel</button>   {{!-- only button is type='button' --}}
</form>
```

```
components/chat-form.gts:24: error [wcag/h32] <form> element must have a submit button
```

### Camel-case attribute names

HTML5 attribute names are case-insensitive and lowercase canonical. Camel-case in source compiles down to lowercase in the DOM, so attribute selectors silently fail.

```hbs
<div data-test-userMenuList></div>   {{!-- ← lowercased to data-test-usermenulist --}}
```

```
templates/page.gts:42: error [attr-case] Attribute "data-test-userMenuList" should be lowercase
```

### Duplicate CSS class

```hbs
<div class='flex w-full focus:bg-blue-500 focus:text-white rounded-md flex grow gap-2'>
                                                                  ↑↑↑↑
                                                                  duplicate "flex"
```

```
components/menu-button.gts:18: error [no-dup-class] Class "flex" duplicated
```

### Invalid attribute values

```hbs
<img alt='Logo' width='100px' />   {{!-- ← width must be unitless integer --}}
<input type='checkbox' readonly />  {{!-- ← readonly only valid on text-like inputs --}}
```

```
components/footer.gts:12: error [attribute-allowed-values] Attribute "width" has invalid value "100px"
templates/admin.gts:18: error [input-attributes] Attribute "readonly" not allowed on <input type="checkbox">
```

---

## Inline errors in VS Code

Install the official extension: [html-validate.vscode-html-validate](https://marketplace.visualstudio.com/items?itemName=html-validate.vscode-html-validate).

The extension only validates files whose **VS Code language ID** is in its `html-validate.validate` allow-list. The default list is `["html", "javascript", "markdown", "vue", "vue-html"]` — none of which match `.gts` / `.gjs` / `.hbs`. Add the Ember/Glimmer language IDs to your project's `.vscode/settings.json`:

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

The Glimmer language IDs (`glimmer-ts` for `.gts`, `glimmer-js` for `.gjs`) are registered by the Glimmer / Glint extensions:
- [`lifeart.vscode-glimmer-syntax`](https://marketplace.visualstudio.com/items?itemName=lifeart.vscode-glimmer-syntax) (syntax highlighting + grammars)
- [`typed-ember.glint2-vscode`](https://marketplace.visualstudio.com/items?itemName=typed-ember.glint2-vscode) (Glint language service)

Either one is enough. (`gts` / `gjs` shown in the language picker are display *aliases* — the actual ID is `glimmer-ts` / `glimmer-js`. Same trick Vue uses with `vue` / `vue-html`.) `handlebars` is a built-in language ID.

After adding the setting, **reload the VS Code window** (Cmd+Shift+P → "Developer: Reload Window"). The html-validate extension activates lazily — if you don't see "HTML-Validate" in the Output dropdown, run **"Developer: Show Running Extensions"** to confirm it loaded, and check **"Workspaces: Manage Workspace Trust"** (the extension refuses to run in untrusted workspaces).

> **If you installed via `pnpm install file:/path/to/html-validate-ember`** and you've updated the local source: pnpm's `file:`-dep cache doesn't always invalidate on source-content changes. Bump the version in `html-validate-ember/package.json` (or run `pnpm install --force` in the consuming project), then reload VS Code. Stale plugin code looks like phantom diagnostics that don't reproduce when running `validate-gts` from the terminal.

## Glint integration (opt-in)

When `@glint/ember-tsc` is installed in your project, the transformer can extract TypeScript type information for two patterns:

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

### Enabling Glint

Pass `--glint` to the bundled CLI or set `HVE_GLINT=1` in the environment:

```sh
npx validate-gts --glint app
# or, when invoking html-validate directly:
HVE_GLINT=1 npx html-validate 'app/**/*.gts'
```

Glint integration adds significant per-file overhead (TS program rebuild + module rewrite + TypeChecker calls). The static-resolution path is the default for that reason; turn Glint on for design-system-style codebases with strict typing discipline.

### Caching

Glint results are content-addressed and cached on disk under `node_modules/.cache/html-validate-ember/glint/`. The cache key includes file SHA + tsconfig SHA + plugin version, so:

- **Repeat runs** (CI, pre-commit, IDE re-validation) skip the entire Glint pipeline for unchanged files. On the audited 207-file codebase: ~464s cold → ~2.5s warm.
- **Plugin upgrades** invalidate all entries naturally (version is in the key).
- **Tsconfig changes** invalidate per-project entries.

Set `HVE_NO_CACHE=1` to bypass the cache (e.g. when debugging the Glint pipeline). Set `HVE_DEBUG=1` to print per-file skip reasons during preload (non-gts/gjs, read error, rewrite returned empty/error) — useful when you see a non-zero "skipped" count and want to know what fell out.

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
   ```

   Use the long form `{{!-- ... --}}`, not `{{! ... }}`. The transformer rewrites the long form to a `<!-- -->` HTML comment in place; the short form is too short to fit `<!-- -->` while preserving byte length.

   **Inline reason / link** — append `-- text` *inside* the brackets (html-validate's directive parser splits on `--` after the rule name):
   ```hbs
   {{!-- [html-validate-disable-next unique-landmark -- pending https://github.com/w3c/html-aria/issues/579] --}}
   <header>...</header>
   ```

   Trailing text *after* the closing `]` does **not** parse — html-validate raises `parser-error: Missing end bracket "]" on directive`. The reason has to live inside the brackets.

   Variants (per html-validate's [inline-config docs](https://html-validate.org/usage/inline-config.html)):
   - `html-validate-disable rule` — disables `rule` for the rest of the file (or until re-enabled with `html-validate-enable`).
   - `html-validate-disable-next rule` — disables for the next element only.
   - `html-validate-disable-block rule` — disables for all siblings and descendants of the directive's parent that follow the directive. Useful for scoping to e.g. a whole `<dialog>` subtree:
     ```hbs
     <dialog>
       {{!-- [html-validate-disable-block unique-landmark -- pending https://github.com/w3c/html-aria/issues/579] --}}
       <header>...</header>
       <section>...</section>
     </dialog>
     ```

## How positions work

`content-tag` gives byte offsets for each `<template>` block's content. We compute `line:column` for the block's start, attach as the `Source` base, and emit length-equivalent HTML so byte positions inside the template match positions inside the original `.gts`. html-validate adds reported positions to the base.

No SourceMap machinery — same approach `html-validate-vue` and `html-validate-angular` use.

## Multipass branch validation

`{{#if}}/{{else}}` (and `{{else if}}` chains) are validated **per branch by default**. The transformer enumerates branch combinations, yields one html-validate `Source` per combination, and html-validate validates each independently. Errors from every branch surface — including the un-selected branch under single-pass.

Enumeration is capped at the first **10 conditional branches per template** to bound work; "conditional branch" here means any block helper with both a program and an `{{else}}` clause. The common forms are `{{#if/else}}`, `{{#unless/else}}`, and `{{#each/else}}` (empty fallback), but custom block helpers (`{{#my-helper x}}A{{else}}B{{/my-helper}}`) count too. Surplus conditional branches fall back to the single-branch heuristic, which can hide errors in their unselected arms. Override with `--max-conditional-branches=N` on `validate-gts`, or `HVE_MAX_CONDITIONAL_BRANCHES=N` when invoking html-validate directly. Set `N=0` to disable multipass and use the single-branch heuristic everywhere.

Enumeration is **tree-aware**: branches are organized by nesting, and choosing one arm of a branch only enumerates that arm's nested branches. This matches the runtime DOM — choices inside a blanked arm can't affect what html-validate sees — and turns 2^N worst case into far fewer calls on nested templates. A 6-deep `{{#if}}/{{else}}` chain produces 7 distinct passes rather than 64. Pure-sibling branches still scale 2^N, so the cap matters most there.

The bundled `validate-gts` CLI dedupes identical messages by `(line, column, ruleId, message)` before printing, so an error stable across branches (e.g., a misnested element *outside* the if/else) is reported once even though it lives in every pass. The dedupe util is also exported as `dedupeMultipassReport` from `lib/multipass-dedupe.js` for custom consumers.

## Known limitations

- **Static-string scope.** `{{NAME}}` resolves against same-file `const NAME = '...'` declarations and one-level-deep `import { NAME } from './sibling'` (relative paths only — package and path-aliased imports are skipped). `{{this.field}}` resolves against same-file class-field initializers (`field = '...'` or `field: T = '...'`). What's not resolved: transitive re-exports (`export { X } from './...'` chains), default imports, namespace imports, and getters returning literals — Glint narrows some of these to string-literal types when `--glint` is on, which the blanker picks up through a separate code path.
- **TS-flavored block-param types are stripped, not parsed.** `@glimmer/syntax`'s parser doesn't understand `{{#each items as |item: T|}}`-style annotations (or the comma separators that come with multi-param lists). The transformer pre-strips them to whitespace before Glimmer parses, with balanced-bracket scanning so unions (`A | B`), object types (`{ a: number }`), parenthesized types (`(A | B)[]`), generics (`Map<string, number>`), arrays (`T[]`), and qualified names (`NS.Type`) all work. Length-preserving — AST offsets after the strip match original source. The strip only operates inside `as |…|` ranges of mustache openers; type literals appearing elsewhere in the template aren't touched (and Glimmer wouldn't accept them there anyway).

## Future work

- **Custom rules** — html-validate plugins can ship their own rules. Candidates: `ember-prefer-glimmer-comment-directive` (flag `<!-- [html-validate-disable …] -->` and suggest `{{!-- … --}}`), `ember-component-naming` (enforce PascalCase / dotted invocations).
- **Piecewise string-builder** in `blank.ts` — current `split('')` / `join('')` is O(n) per `<template>` block; not a bottleneck on real codebases (sub-second for 1000-line files).

## Inspecting what gets emitted

When debugging a false positive:

```sh
node node_modules/html-validate-ember/dump-blanked.js path/to/file.gts
```

Prints the original `<template>` body and the length-equivalent HTML the transformer hands to html-validate. False positives are usually traceable to the blanker losing or mis-emitting structure.

## Contributing

PRs welcome. Run `npm test` for the unit + integration suite.
