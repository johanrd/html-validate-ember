# super-rentals — triage

> **Historical.** Captured under the pre-change preset where `:gts-recommended` enforced `void-style: selfclosing`. The 6× `void-style` findings here no longer fire under the current default (now `off`); they're preserved as-is to document what motivated that change.

Pinned at `3d0480f066b27b8410136a858320a47671affbe3`. 14 files validated, 13 findings.

| # | File | Line | Rule | Verdict | Notes |
|---|------|------|------|---------|-------|
| 1 | `app/components/map.gjs` | 28 | `void-style` | TP | `<img …>` should be `<img />` per `:gts-recommended` |
| 2 | `app/components/rental/image.gjs` | 15 | `element-required-attributes` (`src`) | **FP-plugin** | `<img ...attributes>` — splat will provide `src`/`alt` at runtime, plugin blanks the splat and html-validate then flags missing required attrs |
| 3 | `app/components/rental/image.gjs` | 15 | `wcag/h37` (`alt`) | **FP-plugin** | Same as #2 |
| 4 | `app/components/rental/image.gjs` | 15 | `void-style` | TP | `<img …>` style |
| 5 | `app/components/rentals.gjs` | 25 | `wcag/h32` | TP | Search form lacks an explicit submit button (relies on Enter on the input). a11y issue: keyboard users without an obvious submit |
| 6 | `app/components/rentals.gjs` | 28 | `no-implicit-input-type` | TP | `<input>` has no `type` — defaults to text but explicit is recommended |
| 7 | `app/components/rentals.gjs` | 28 | `void-style` | TP | `<input>` style |
| 8 | `app/templates/contact.gjs` | 8 | `void-style` | TP | `<br>` style |
| 9 | `app/templates/contact.gjs` | 14 | `void-style` | TP | `<br>` style |
| 10 | `app/templates/contact.gjs` | 17 | `tel-non-breaking` (space) | TP (typography nit) | Phone number should use `&nbsp;` between groups |
| 11 | `app/templates/contact.gjs` | 17 | `tel-non-breaking` (space) | TP (typography nit) | Same |
| 12 | `app/templates/contact.gjs` | 17 | `tel-non-breaking` (hyphen) | TP (typography nit) | Should use `&#8209;` (non-breaking hyphen) |
| 13 | `app/templates/contact.gjs` | 17 | `void-style` | TP | `<br>` style |

## Summary

- **TP** (real findings worth filing): 11
- **FP-plugin** (our gap, fixable): 2 — both from `...attributes` splat on `<img>` masking the runtime-provided `src`/`alt`
- **FP-rule** / **intentional**: 0

## Notes for filing the upstream issue

super-rentals is a *tutorial app*; the omitted-end-tag void-style is the simpler form learners are taught first. Filing 6× `void-style` would be noise. Worth filing as one issue:
- The genuine a11y/correctness findings (`wcag/h32`, `no-implicit-input-type`)
- A note that `:gts-recommended` enforces self-closing void style and the templates currently use the omitted form (informational, not a request to change)
- The typography nits as a one-line aside

## Plugin work this surfaces

Issue: `<img ...attributes>` should not fire `element-required-attributes` (`src`) or `wcag/h37` (`alt`). Symmetric to the existing `<input>` synthetic `type=' '` injection (`blank.ts:644-648`): when a `...attributes` splat is present on `<img>`, inject synthetic `src=' '` and `alt=' '` into Glimmer-attr blank regions so html-validate sees the runtime-provided attrs as "present, value unknowable" rather than "missing".

Same pattern likely applies to other void elements with required attrs that are commonly splat-supplied (`<source>`, `<track>`, `<area>`, `<iframe>`'s `src`/`title`). Worth a generalized fix: for any void native that has required attrs *and* a `...attributes` splat present, inject synthetic placeholders for the missing required attrs.
