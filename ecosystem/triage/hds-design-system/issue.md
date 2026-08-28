# hds-design-system — draft issue

**Title:** A few HTML/a11y findings surfaced by `html-validate-ember`

**Repo:** https://github.com/hashicorp/design-system

**Body:**

I ran [`html-validate-ember`](https://github.com/johanrd/html-validate-ember) against this repo with Glint enabled. Pinned at commit `9db0ff66`. Most findings are limitations on my plugin's side (curried-component yielded slots, arg-bound required attributes, etc. — being tracked separately) but a few look like real fixes worth surfacing.

## Real findings

### `<input>` nested inside `<a>` (5 instances)

Interactive content cannot be nested inside `<a>` per HTML spec — both ATs and form behavior get confused. Locations include `<HdsLinkInline>`-derived components that wrap form inputs.

(I can pull exact lines on request — they're behind some component composition that's a pain to grep through, but `validate-gts` lists them.)

### Nested `<a>` inside `<a>` (2 instances)

Same shape — nested anchors are invalid and can lead to ambiguous click targets / focus order.

### `<div>` inside `<button>` for icon+label layout (14 instances)

`<button>` permits *phrasing content* only; `<div>` is flow content. Locations include `app-footer/link.gts`, `app-header/home-link.gts`, `app-side-nav/list/link.gts`, `breadcrumb/item.gts`. Browsers tolerate this, but the markup is invalid and AT behavior is implementation-dependent. Could be `<span class="...">` instead — phrasing content, same display behavior.

### `<button>` missing explicit `type` (6 instances)

When a `<button>` is inside a `<form>` (or transitively yielded into one) the default behavior is `type="submit"`, which can cause unexpected submissions. Adding `type="button"` (or `"submit"` if that's intended) makes it explicit.

### `aria-label` misuse (~5 of 8 findings)

Several locations use `aria-label` on elements where it isn't recommended (`<a>` without role, certain landmark configurations). Worth a sweep — html-validate distinguishes "strictly allowed but not recommended" from "cannot be used on this element"; both are worth checking.

### Misc

- `selected="true"` on `<option>` (`mock/.../add-user.gts:87`) — boolean attribute style; `<option selected>` is the canonical form. Two findings (`attribute-boolean-style` + `attribute-allowed-values`) at the same span.
- `scope` on `<td>` (`packages/components/src/components/hds/table/index.gts:399`) — `scope` is deprecated on `<td>` (only valid on `<th>`).

### Defensive but worth noting

15× `role="list"` on `<ul>` — usually redundant per spec, but a *deliberate workaround* for Safari/VoiceOver stripping the implicit list role when `list-style: none` is applied. Worth keeping. Mentioned for completeness.

## Skipping in this issue

The bulk of the findings are plugin-side limitations being tracked separately:

- ~107× `<option>` not permitted under `<div>` — yielded curried-component sub-elements (`<HdsFormSelectBase as |C|><C.Options>...</C.Options>`) lose Glint type info during transparent blanking.
- ~39× `<iframe>` missing required `title` — `<ShwFrame @label={{...}}>` provides title via arg-binding; my plugin doesn't yet infer required attrs from arg-binds.
- 25× `<div>` under `<ul>` — addon list-item components (`<HdsAppSideNav.List.Item>`-style) render `<li>` but plugin can't resolve through component composition.
- 6× `wcag/h32` on `<HdsForm>` and 4× `wcag/h71` on `<HdsForm.Fieldset>` — yield-only structural forms; plugin can't see consumer-provided submit/legend.
- 9× `no-inline-style` — common in showcase prose.
- 8× mysterious `<div>` under `<abbr>` — Glint resolution is mapping a generic `HTMLElement` to `<abbr>` somewhere.

## Reproducing

```bash
git clone https://github.com/johanrd/html-validate-ember
cd html-validate-ember
npm install && npm run build
npx validate-gts --glint /path/to/design-system
```

Happy to send PRs for any of the real findings above.
