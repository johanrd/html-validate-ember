# ember-simple-auth — triage

Pinned at `27bd323f4c7f35e8aa19e770f095b06b839ca479`. 11 files validated, 6 findings.

| # | File | Line | Rule | Verdict | Notes |
|---|------|------|------|---------|-------|
| 1 | `packages/test-app/app/components/login-form.hbs` | 2 | `prefer-native-element` | TP | `<a class="btn btn-primary" href="#" role="button">Login with Facebook</a>` — anchor used as button. WCAG: should be `<button type="button">`. |
| 2 | `packages/test-app/app/components/login-form.hbs` | 4 | `prefer-native-element` | TP | Same pattern (Google implicit grant link). |
| 3 | `packages/test-app/app/components/login-form.hbs` | 14 | `autocomplete-password` | TP | `<input type="password">` should have `autocomplete="current-password"` (or `"new-password"` for sign-up). Modern browsers + password managers require this. |
| 4 | `packages/test-app/app/components/main-navigation.hbs` | 27 | `wcag/h32` | TP | `<form class="form-inline">` wraps login/logout *links* (no actual submit button). Either drop the `<form>` (it's not a form) or convert the links to `<button>`. |
| 5 | `packages/test-app/app/components/main-navigation.hbs` | 37 | `prefer-native-element` | TP | Same `<a role="button" href="#">` pattern (logout link). |
| 6 | `packages/test-app/lib/my-engine/addon/templates/protected.hbs` | 7 | `no-implicit-button-type` | TP | `<button {{on "click" this.logout}}>` — explicit `type="button"` recommended. |

## Summary

- **TP**: 6 (all real)
- **FP-plugin**: 0
- **FP-rule**: 0

All findings are in `packages/test-app` — the demo/example app shipped with the addon. They're real a11y/correctness issues but the impact is bounded (this is example code, not a published consumer-facing app).

## Notes for filing

Test-app code is documentation-as-example: people copy-paste from these. Filing matters because the patterns get propagated. The anchor-as-button anti-pattern (`role="button"` on `<a href="#">`) is the most important — it's a textbook a11y mistake that's been replicated 3× here.

`autocomplete-password` is modern-browser-required; password managers won't fill correctly without it.

`wcag/h32` on the navigation form is questionable — the form may not actually be a form. Suggest a maintainer judgment call.
