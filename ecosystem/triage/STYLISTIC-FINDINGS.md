# Stylistic findings — input for default-policy review

Tracks rules that fired during triage which are **stylistic preferences** rather than correctness issues. The question for each: should the plugin's `:gts-recommended` preset turn this off (or weaken it) by default? Decision wants empirical data — counts across real Ember repos, not gut feel.

A "stylistic" finding here means: removing it never changes the rendered DOM, never affects accessibility tree, never triggers a real bug. Code works the same either way. Maintainers may still prefer it on for consistency, but defaulting to *off* avoids noise for users who don't care.

## Tally (updated as triage progresses)

| Rule | Total findings | Targets | Notes |
|---|---|---|---|
| `void-style` | 6 (super-rentals so far) | super-rentals | Plugin sets `void-style: ['error', { style: 'selfclosing' }]` in `:gts-recommended`. Forces `<br />` over `<br>`. Pure preference. |
| `tel-non-breaking` | 3 (super-rentals so far) | super-rentals | Telephone-number typography (`&nbsp;` between groups, `&#8209;` for hyphens). Pure preference; some users argue this is a11y-adjacent (line-break prevention). |
| `no-inline-style` | 4 (ember-primitives docs) | ember-primitives | All in docs landing page; common in static demo prose. Real preference but not a bug. |
| `prefer-native-element` (region only) | 1 (ember-primitives accordion) | ember-primitives | `<div role="region">` ↔ `<section>` choice — both are correct landmarks; native vs ARIA-attribute is style. Other `prefer-native-element` cases (heading, progressbar) are real recommendations and not stylistic. |
| (rules added as more targets are triaged) | | | |

## Decision criteria (apply once tally is complete)

- **>50% of total ecosystem findings come from one stylistic rule** → strong signal to default-off; otherwise users will turn it off project-by-project anyway and it just causes noise on the first run.
- **Rule fires in the *majority* of targets but most maintainers haven't disabled it** → maintainers tolerate it; can leave on but document opt-out clearly.
- **Rule fires in only 1-2 targets, low total count** → niche; can leave on at default settings.

## Candidates to consider

- `void-style` — definitely a candidate if total count is high. The choice between `<br>` and `<br />` is style-only. Ember's own code & community split on this.
- `tel-non-breaking` — niche but high noise where it does fire. Probably safe to default-off.
- (more added during triage)

## Out of scope

This document is *not* about FPs (those go in `FP-FIX-REPORT.md`). It's about TPs that are correct findings the user might not care about. Tracking them here helps decide whether the *recommended preset* should soften, separate from any bug fixes.
