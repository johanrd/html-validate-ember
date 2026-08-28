# limber — draft issue

**Title:** HTML/a11y findings in `apps/repl` and `apps/tutorial` surfaced by `html-validate-ember`

**Repo:** https://github.com/NullVoxPopuli/limber

**Body:**

I ran [`html-validate-ember`](https://github.com/johanrd/html-validate-ember) (a Glimmer-aware transformer for [`html-validate`](https://html-validate.org)) against this repo with Glint enabled. Pinned at commit `b7d73e54`.

Most findings are stylistic; the rest are a few real a11y/structural issues.

## Real findings

### Misnested `<p>` containing `<ul>` / `<dl>` (10 blocks, 20 reports)

`<p>` may not contain block elements. The browser implicitly closes the `<p>` before the `<ul>`/`<dl>`, and the explicit `</p>` later becomes a stray end-tag.

Locations:
- `apps/repl/app/components/verify-danger.gts:155`
- `apps/repl/app/templates/docs/embedding.gts:87`
- `apps/repl/app/templates/docs/repl-sdk.gts:130, 154, 196, 207, 239, 257, 276` (and more — total 9 blocks in this file)
- `apps/repl/app/templates/error-404.gts:12`

Fix: split into two `<p>` blocks around the list, or change the wrapper to a `<div>` if a paragraph isn't semantically intended.

### `aria-label` on `<span>` not exposed (`apps/repl/app/templates/docs/support/api.gts:14, 17`)

```gts
<span class="tag-label" aria-label="live" style="display: inline-block">⚡ live</span>
<span class="tag-label" aria-label="Refresh" style="display: inline-block">🔃 reload</span>
```

`aria-label` is only valid on interactive or explicitly-roled elements. On a plain `<span>` ATs typically ignore it, so the emoji is announced by its Unicode name (or not at all) and the intended "live" / "Refresh" label is silent. Either add `role="img"` (turns the span into an a11y-leaf node) or move the text to visible content with the emoji as decoration.

### Multiple unlabeled `<footer>` landmarks (`apps/repl/app/templates/edit/layout/status.gts:44, 52`)

Two `<footer>` elements (one for last status, one for the error pane). When 2+ same-role landmarks exist, each needs `aria-label` (or `aria-labelledby`) to be uniquely identifiable in the AT's landmark list.

### `<form>` without submit button (`apps/repl/app/templates/docs/support/api.gts:140`)

Same WCAG H32 pattern — either add a `<button type="submit">` or convert the form to a non-form structure if no submission happens.

### Missing `type` attributes

- `<input>` missing `type` — `apps/repl/app/templates/docs/support/api.gts:175`, `apps/repl/app/templates/edit/share.gts:167`.
- `<button>` missing `type` — `apps/repl/app/templates/edit/format-buttons.gts:39` (the `<Option>` component is Glint-resolved to a `<button>`).

## Skipping in this issue

- 10× `no-inline-style` — UI/demo inline styles, often pragmatic.
- 1× `<style>` inside `<label>` (`apps/tutorial/app/components/selection.gts:50`) — strict-spec violation but a common pattern for component-scoped CSS.

## Reproducing

```bash
git clone https://github.com/johanrd/html-validate-ember
cd html-validate-ember
npm install && npm run build
npx validate-gts --glint /path/to/limber/apps/repl
```

Happy to send PRs for any of these.
