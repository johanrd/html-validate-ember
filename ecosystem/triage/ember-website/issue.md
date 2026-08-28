# ember-website — draft issue

**Title:** A handful of HTML/a11y findings surfaced by `html-validate-ember`

**Repo:** https://github.com/ember-learn/ember-website

**Body:**

I ran [`html-validate-ember`](https://github.com/johanrd/html-validate-ember) against this repo. Pinned at commit `43ac579`. Most findings are stylistic or limitations on my plugin's side (tracked separately); a small set are real fixes worth your time.

## Real findings

### `<image>` is not a valid HTML element (`app/templates/index.hbs:137`)

```hbs
<image xmlns="http://www.w3.org/2000/svg" x="140" y="150" width="200" height="200" xlink:href="..." />
```

This is inside an SVG context (`<image>` IS valid SVG), but it's at template top-level without a wrapping `<svg>` — the parser treats it as HTML and `<image>` is invalid HTML. Either wrap in `<svg>...<image .../></svg>` or use `<img>` if the browser-level rendering is what's wanted.

### Duplicate form control names (`app/templates/mascots/commission.hbs`, 6 instances)

Several form controls share `name="Field8"`. Form submissions then send ambiguous data — server-side processing can't distinguish which control was which. Each control should have a unique `name`.

### Misnested `<p>` containing block elements (1 block, 2 reports)

`<p>` may not contain `<ul>`/`<dl>`. The browser implicitly closes the `<p>` before the block element, and the trailing `</p>` becomes a stray end-tag.

### Deprecated attributes (2 instances)

- `app/templates/community/index.hbs:118` — `frameborder` on `<iframe>` (deprecated HTML4; use CSS `border: 0`).
- `app/templates/community/meetups/index.hbs:67` — `align` on `<img>` (deprecated; use CSS).

### `aria-labelledby` on element that doesn't accept it (`app/templates/learn/index.hbs:3`)

Some elements (most notably `<div>`) require an explicit role for `aria-labelledby` to be exposed to ATs. Real a11y fix; check the specific element in context.

### `<pre>` inside `<code>` (`app/components/index/ember-addons.hbs:41`)

`<code>` is phrasing content; `<pre>` is flow content. Browsers tolerate this, but the markup is invalid and ATs may behave oddly. Either swap (`<pre><code>...</code></pre>`) or drop the `<code>` wrapper.

### Conditional comments (4 instances in `app/templates/mascots/payment.hbs`)

`<!--[if IE]>` style comments. Modern browsers ignore them; obsolete IE compatibility code. Safe to delete.

## Skipping in this issue

Stylistic findings (~163 total) are out of scope:
- 153× `void-style` — the templates use `<br>` over `<br />`. Both are valid HTML; my plugin's preset enforces self-closing per ember-template-lint convention but the omitted form is also fine.
- 7× `attribute-boolean-style` (`checked="checked"` vs `checked`) — pure preference.
- 2× `prefer-button` (`<input type="submit">` vs `<button>`) — both valid.
- 1× `no-inline-style`.

The ~98 `element-permitted-content` reports (mostly survey templates and `browser-support.hbs`) are FPs from my plugin: `<EsCard>` from `ember-styleguide` renders `<li>` but my plugin can't resolve that without JS-side type information, so children float to `<ul>` and the rule fires incorrectly. I'm tracking this on my side.

## Reproducing

```bash
git clone https://github.com/johanrd/html-validate-ember
cd html-validate-ember
npm install && npm run build
npx validate-gts /path/to/ember-website
```

Happy to send PRs for any of the real findings above.
