# ember-power-select — draft issue

**Title:** Several HTML/a11y findings in docs and tabs surfaced by `html-validate-ember`

**Repo:** https://github.com/cibernox/ember-power-select

**Body:**

I ran [`html-validate-ember`](https://github.com/johanrd/html-validate-ember) (a Glimmer-aware transformer for [`html-validate`](https://html-validate.org)) against this repo with Glint enabled. Pinned at commit `bf21b6c0`. Three notable patterns:

## 1. Code-example tabs are `<div role="button">` (12 instances)

`docs/app/components/code-example.gts:53,60,67,74,81,88,95,102,109,116,123,130` — each tab in the multi-tab code preview is:

```gts
<div role="button" {{on "click" (fn this.setActiveTab "glimmer-ts")}}>
  Template
</div>
```

Two issues:

- **Native `<button type="button">` would be safer** — div+role+click handler doesn't get Space/Enter/keyboard-focus semantics for free; the platform gives them to `<button>` without manual wiring.
- **Or arguably, since they're tabs inside `<nav class="code-example-tabs">`, the proper pattern is `role="tab"` with `aria-selected` state on each tab and `role="tabpanel"` on the body.** Either change resolves the WCAG flag; the tab pattern is closer to what's actually being modeled.

## 2. Misnested `<p>` containing `<ul>` / `<dl>` (7 instances)

`<p>` may not contain block elements. The browser implicitly closes the `<p>` before the `<ul>`/`<dl>`, and the trailing `</p>` then becomes a stray end-tag, which html-validate flags twice (`no-implicit-close` + `close-order`).

```hbs
<p>
  In plain English, ...
  <ul>
    <li>...</li>
  </ul>
</p>
```

Locations: `docs/app/templates/public-pages/cookbook/css-animations.gts:48`, `docs/app/templates/public-pages/docs/architecture.gts:16, 84, 154, ...`.

Fix: split into two `<p>` blocks around the list, or change the wrapper to a `<div>` if a paragraph isn't semantically intended.

## 3. `<br>` inside `<ol>` for visual spacing (1 instance)

`docs/app/templates/public-pages/docs/troubleshooting.gts:30` — a `<br />` between `<li>` items inside an `<ol>`. `<ol>` only permits `<li>`. Replace with CSS (`li + li { margin-top: … }` or similar) for the same visual effect.

## Skipping in this issue

- 6× `no-inline-style` findings in demo-app placeholders — those examples use inline styles to demonstrate option labels with arbitrary user-supplied formatting. Probably intentional.
- 1× `<div>` reportedly under `<abbr>` in `src/components/power-select.gts:1443` — looks like a plugin-side Glint resolution issue, not a real bug; I'm tracking that on my side.

## Reproducing

```bash
git clone https://github.com/johanrd/html-validate-ember
cd html-validate-ember
npm install && npm run build
npx validate-gts --glint /path/to/ember-power-select
```

Happy to send PRs for any of these.
