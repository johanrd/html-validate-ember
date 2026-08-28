# ember-primitives — draft issue

**Title:** A few a11y findings surfaced by `html-validate-ember`

**Repo:** https://github.com/universal-ember/ember-primitives

**Body:**

I ran [`html-validate-ember`](https://github.com/johanrd/html-validate-ember) (a Glimmer-aware transformer for [`html-validate`](https://html-validate.org)) against this repo with Glint enabled. Most findings are stylistic or limitations on my side, but a few look like real fixes.

Pinned at commit `b8a890e9`.

## Real findings

**`accordion/header.gts:20` — `<div role="heading" aria-level="3">` should be `<h3>` (or appropriate level)**

Native heading elements convey both heading semantics *and* document-outline level to assistive tech in one go. `role="heading" aria-level="N"` requires the AT to combine two attributes correctly, which is more error-prone in practice. If the level is dynamic, consider an `<h1>`-`<h6>` selection in the consumer; if fixed, just use the native tag.

**`progress.gts:134` — `<div role="progressbar" aria-valuemax aria-valuenow ...>` should be `<progress>`**

`<progress max value>` is the native equivalent and gets accessible-value semantics + automatic UI affordance for free. Same WCAG rationale as the heading case.

**`rating/stars.gts:53` — `readonly` on `<input type="radio">` has no effect**

```hbs
<input
  id="input-{{id}}"
  type="radio"
  name={{@name}}
  value={{star}}
  readonly={{@isReadonly}}
  ...
/>
```

Per HTML spec, `readonly` is only valid on text-type inputs (`text`, `password`, `search`, `tel`, `url`, `email`, `date`, `time`, `number`). On `type="radio"` the browser ignores it. To prevent interaction, use `disabled` instead — and if disabled-but-still-submittable is the goal, keep an inert visual state at the wrapping fieldset/form layer.

## Other findings (skipping in this issue)

- 4× `no-inline-style` in `docs-app/index.gts` — inline styles in a docs landing page; usually a deliberate choice to avoid an extra CSS file for prose.
- 1× `<div role="region">` in accordion content — could be `<section>` (with name) but the current form is fine.
- `<style>` inside `<fieldset>` for screen-reader-only CSS — out of strict spec but works.
- `wcag/h32` / `wcag/h71` on `<Form>`, `<OTP.Input>`, `<Rating>` — these are FPs from my plugin's side; the components yield to consumers who provide the submit button / legend. Will fix on the plugin side.

## Reproducing

```bash
git clone https://github.com/johanrd/html-validate-ember
cd html-validate-ember
npm install && npm run build
npx validate-gts --glint /path/to/ember-primitives
```

Happy to send a PR for any of the above.
