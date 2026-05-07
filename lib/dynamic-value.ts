// Cross-module sentinel for the "attribute present, value unknowable"
// signal: an attribute value of pure whitespace, length >= 3.
//
// Convention shared by:
//   - blank.ts (`tryInjectInputType`, `tryInjectImgRequiredAttrs`,
//     `tryInjectComponentAttrs`, `substituteSelfClosingComponent`,
//     etc.) — emits `name='   '` into the blanked output.
//   - lib/component-attrs.ts (`literalAttrs`) — records arg-bound /
//     concat-mustache attrs with the same placeholder so the blanker
//     injects them at the consumer's call site.
//   - transform.ts (`processAttribute` hook) — converts matching
//     attribute values to a `DynamicValue` instance.
//
// The threshold (3) is the smallest length that distinguishes our
// injected placeholder from a 1- or 2-space literal a user might write
// on purpose. Callers must use `DYNAMIC_VALUE_PLACEHOLDER` literally
// (not just any whitespace string) so any future tweak — e.g. raising
// the threshold or changing the sentinel character — happens in one
// place.

export const DYNAMIC_VALUE_PLACEHOLDER = '   ';

const DYNAMIC_VALUE_MIN_LENGTH = DYNAMIC_VALUE_PLACEHOLDER.length;

export function isDynamicValuePlaceholder(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= DYNAMIC_VALUE_MIN_LENGTH &&
    /^\s+$/u.test(value)
  );
}
