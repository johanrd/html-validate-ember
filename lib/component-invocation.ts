import type { HtmlElement } from 'html-validate';

// A registered symbol, so the mark survives two copies of this module (src and dist).
const COMPONENT_INVOCATION = Symbol.for('html-validate-ember.componentInvocation');

export function markComponentInvocation(element: unknown): void {
  (element as Record<symbol, boolean>)[COMPONENT_INVOCATION] = true;
}

/**
 * True when html-validate sees the element in place of a component invocation
 * (`<MyDialog>` validated as the `<dialog>` it renders), not an element written in the template.
 */
export function isComponentInvocation(element: HtmlElement): boolean {
  return (element as unknown as Record<symbol, boolean>)[COMPONENT_INVOCATION] === true;
}
