// Hardcoded mapping for Ember's canonical built-in components — those
// shipped with the framework that every Ember app uses regardless of
// Glint setup. Used as a fallback when Glint doesn't resolve a
// component invocation (the `.hbs` case primarily, where Glint isn't
// even loaded; also `.gts` / `.gjs` runs without `--glint`).
//
// The shape mirrors what `lib/component-attrs.ts` produces from a
// real component file: `{ tag, attrs, hasSplat }`. Glint-driven
// resolution (when available) takes precedence — these are pure
// fallback. For `<Input>` and `<Textarea>` the rendered native is
// trivial; `<LinkTo>` is more nuanced because the rendered `<a>`'s
// `href` comes from `@route`/`@model` at runtime — we add a
// 3-space whitespace placeholder so html-validate's `processAttribute`
// hook converts it to `DynamicValue` (passes anchor-href rules
// without claiming a specific value).
//
// References:
//   https://api.emberjs.com/ember/release/classes/Component
//   https://api.emberjs.com/ember/release/classes/LinkTo
//   https://api.emberjs.com/ember/release/classes/Input
//   https://api.emberjs.com/ember/release/classes/Textarea

export interface ComponentAttrs {
  tag: string;
  attrs: Record<string, string>;
  hasSplat: boolean;
}

export const BUILTIN_COMPONENTS: ReadonlyMap<string, ComponentAttrs> = new Map<
  string,
  ComponentAttrs
>([
  // <Input @value=... @type='text' /> renders <input type='text' value=...>.
  // Default `@type` is 'text' but parents commonly override; the void-
  // substitution path's tryInjectInputType injects a 3-space `type='   '`
  // placeholder anyway, so DynamicValue handling kicks in regardless.
  ['Input', { tag: 'input', attrs: {}, hasSplat: true }],

  // <Textarea @value=... /> renders <textarea>...</textarea>. Non-void;
  // open+close pair emission applies. No literal type attribute.
  ['Textarea', { tag: 'textarea', attrs: {}, hasSplat: true }],

  // <LinkTo @route='X'>label</LinkTo> renders <a href='/x'>label</a>.
  // The `href` value is computed at runtime from @route + @model + @query;
  // we inject a 3-space placeholder so processAttribute converts to
  // DynamicValue. Without this, html-validate may flag `<a>` as missing
  // `href` (depending on rule config).
  ['LinkTo', { tag: 'a', attrs: { href: '   ' }, hasSplat: true }],
]);

// Returns `{ tag, attrs, hasSplat }` for known built-in components, or
// null when the component isn't a known built-in.
export function lookupBuiltinComponent(name: string): ComponentAttrs | null {
  return BUILTIN_COMPONENTS.get(name) ?? null;
}
