# aria-voyager — triage

Pinned at `d17b494399871171e416fc943e0fb043516dd504`. 3 files validated, 13 findings.

All 13 findings are `prefer-native-element` (`<select>`) on `<div role="listbox">` patterns inside `packages/ember-aria-voyager/tests/rendering/listbox-test.gts`.

| Verdict | Count |
|---|---|
| **intentional** | 13 |

aria-voyager's purpose is to provide keyboard / ARIA listbox / menu / tablist behavior on non-native elements (the platform's `<select>` doesn't expose customization hooks for many of these patterns). The test file uses `<div role="listbox">` *deliberately* — that's the API the modifier enhances. Replacing with `<select>` would defeat the test.

This is a case where html-validate's rule fires correctly per its general logic but doesn't apply in this domain. Maintainer would say "yes, that's the addon's reason for existing." No issue to file. No plugin fix.

## Notes for the README

Worth noting in the plugin's README that addons whose *purpose* is to enhance ARIA-pattern widgets (aria-voyager, ember-power-select on the listbox/combobox front, focus-trap addons, etc.) will frequently surface `prefer-native-element` findings in their tests. Recommended config for that flavor of project: `prefer-native-element: 'off'` (or `'warn'` for the source code, `'off'` for tests).

This isn't an FP and isn't a stylistic-default question — it's an *applicability* question. Adding a "Recommended overrides for project type" section to the plugin README would help.
