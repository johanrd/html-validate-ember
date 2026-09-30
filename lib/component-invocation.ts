import fs from 'node:fs';
import type { HtmlElement } from 'html-validate';

const sources = new Map<string, { mtimeMs: number; text: string }>();

function readSource(filename: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filename);
  } catch {
    return null;
  }
  const cached = sources.get(filename);
  if (cached?.mtimeMs === stat.mtimeMs) return cached.text;
  const text = fs.readFileSync(filename, 'utf8');
  sources.set(filename, { mtimeMs: stat.mtimeMs, text });
  return text;
}

/**
 * True when html-validate sees the element in place of a component
 * invocation (`<Modal>` validated as the `<dialog>` it renders), not an
 * element written in the template. Custom rules can use it to report on
 * the component's own template only.
 */
export function isComponentInvocation(element: HtmlElement): boolean {
  const { filename, offset } = element.location;
  const source = readSource(filename);
  if (source === null) return false;
  const written = /^[^\s/>]+/.exec(source.slice(offset, offset + 200))?.[0];
  return written !== undefined && written.toLowerCase() !== element.tagName.toLowerCase();
}
