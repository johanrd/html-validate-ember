# ember-simple-auth — draft issue

**Title:** A few a11y findings in the demo app surfaced by `html-validate-ember`

**Repo:** https://github.com/mainmatter/ember-simple-auth

**Body:**

I ran [`html-validate-ember`](https://github.com/johanrd/html-validate-ember) (a Glimmer-aware transformer for [`html-validate`](https://html-validate.org)) against `packages/test-app` and surfaced 6 findings. They're all in the demo app rather than the addon source itself, but the demo app is documentation-by-example and the patterns get copied.

Pinned at commit `27bd323`.

## Anchor-as-button (3 findings) — `prefer-native-element`

Three buttons are implemented as `<a href="#" role="button">` rather than `<button type="button">`:

- `packages/test-app/app/components/login-form.hbs:2` (Facebook login)
- `packages/test-app/app/components/login-form.hbs:4` (Google implicit grant)
- `packages/test-app/app/components/main-navigation.hbs:37` (Logout)

This is a recognized [WCAG anti-pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/) — the `role="button"` doesn't quite recover keyboard semantics (anchors fire on Enter, buttons fire on Enter *and* Space), and screen readers handle them inconsistently. Native `<button type="button">` is the recommended fix.

## `<input type="password">` missing `autocomplete` — `autocomplete-password`

`packages/test-app/app/components/login-form.hbs:14` — modern browsers and password managers expect `autocomplete="current-password"` for sign-in forms (or `"new-password"` for sign-up forms). Without it, autofill doesn't work reliably and the user experience degrades.

## `<form>` without submit button — `wcag/h32`

`packages/test-app/app/components/main-navigation.hbs:27` — the `<form class="form-inline">` wraps login/logout links but has no `<button type="submit">` or `<input type="submit">`. Two reasonable fixes: drop the `<form>` (it's not actually a form), or convert the action links to `<button>` and add a submit handler.

## Reproducing

```bash
git clone https://github.com/johanrd/html-validate-ember
cd html-validate-ember
npm install && npm run build
npx validate-gts /path/to/ember-simple-auth/packages/test-app
```

Happy to send a PR if any of these look worth addressing.
