# experiments/

POC code that is **not** part of the published package. Files end in `.poc`
so TypeScript's `*.ts` glob doesn't pick them up; nothing here gets
compiled into `dist/` or shipped to npm.

## What's here

### `wcag-h32-ember.ts.poc` + `auto-commit-form.gts.poc`

Drop-in replacement for html-validate's `wcag/h32` rule that exempts forms
with auto-commit Glimmer modifiers (`{{on 'change' …}}` / `{{on 'input'
…}}` / `{{on 'submit' …}}`).

How it worked end-to-end (when wired up):

1. `blank.ts` detected qualifying modifier on `<form>` and stamped a
   `data-hve-auto-commit` marker attribute over the modifier's
   blanked source bytes (length-preserving).
2. `lib/wcag-h32-ember.ts` mirrored upstream `wcag/h32` logic plus
   skipped marker-bearing forms.
3. `:gts-recommended` simultaneously disabled upstream `wcag/h32` and
   enabled ours.

### Why it isn't shipped

Code-quality concerns specific to this rule:

- **~30 lines duplicated** from upstream `wcag/h32` (`isSubmit`,
  `hasNestedSubmit`, `hasAssociatedSubmit`). Will silently drift if
  upstream changes.
- **The `{{on 'submit' …}}` exemption is opinionated** — some users
  may want it as opt-in only. The other two triggers
  (`change` / `input`) are clearly auto-commit; `submit` isn't.
- **Marker-attribute collision risk**: an unrelated consumer using
  `data-hve-auto-commit` for their own purposes would have their form
  silently exempted.

The auto-commit pattern is real and worth solving; this implementation
just isn't the one we want to publish on day one. If demand surfaces,
revisit either as opt-in (`:experimental` preset) or via an upstream
proposal to html-validate.

### How to revive

1. Rename `.ts.poc` → `.ts` and `.gts.poc` → `.gts`, move them back to
   `lib/` and `examples/` respectively.
2. Re-apply the marker injection in `blank.ts` (search git log for
   `tryInjectAutoCommitMarker` to find the original patch).
3. Re-wire in `index.ts`: import the rule, register under
   `'html-validate-ember/wcag-h32-ember'`, add to `:gts-recommended` rule
   config (turn `wcag/h32` off, turn the new rule on).
4. Add the integration test back.
