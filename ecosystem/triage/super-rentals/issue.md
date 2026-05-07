# super-rentals — draft issue

**Title:** A few HTML/a11y findings surfaced by `html-validate-ember`

**Repo:** https://github.com/ember-learn/super-rentals

**Body:**

I ran [`html-validate-ember`](https://github.com/johanrd/html-validate-ember) (a Glimmer-aware transformer for [`html-validate`](https://html-validate.org)) against super-rentals and it surfaced a handful of findings, mostly minor but a couple worth a look.

Pinned at commit `3d0480f`.

## Real findings

**`app/components/rentals.gjs:25` — `<form>` has no submit button**

```hbs
<form {{on "input" this.updateQuery}} {{on "submit" this.handleSubmit}}>
  <label>
    <span>Where would you like to stay?</span>
    <input name="rental-search-term" class="light">
  </label>
  ...
</form>
```

The form submits on Enter (because there's a single `<input>`, the implicit-submit behavior fires) but a keyboard user without that knowledge has no visible submit affordance. Either add a visually-hidden `<button type="submit">` or note that submission is handled live via `input`.

Reference: [WCAG H32](https://www.w3.org/TR/WCAG20-TECHS/H32.html).

**`app/components/rentals.gjs:28` — `<input>` missing explicit `type`**

```hbs
<input name="rental-search-term" class="light">
```

Defaults to `type="text"` but explicit is recommended (and matches the `<input type='search'>` semantics that the search context implies).

## Stylistic / typography

The remaining findings are stylistic. Whether they're worth changing depends on tutorial preferences:

- `<br>`, `<input>`, `<img>` use the *omitted* end-tag form. `:gts-recommended` enforces *self-closing* (`<br />`, `<input />`, `<img />`) which matches `ember-template-lint`'s `self-closing-void-elements` convention. As a tutorial the simpler form may be intentional.
- `app/templates/contact.gjs:17` — phone number `+1 (503) 555-1212` could use `&nbsp;` between groups and `&#8209;` (non-breaking hyphen) to prevent awkward line breaks. (Three findings from `tel-non-breaking`.)

## Reproducing

```bash
git clone https://github.com/johanrd/html-validate-ember
cd html-validate-ember
npm install && npm run build
npx validate-gts /path/to/super-rentals/app
```

Happy to send a PR if these findings look worth addressing.
