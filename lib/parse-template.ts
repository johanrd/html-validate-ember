import { preprocess, type AST } from '@glimmer/syntax';

// A template is parsed by the transformer, by the multipass branch walk
// and once per pass; the resolver parses the same component templates for
// every consumer. One parse per content string, oldest entry evicted. Parse
// errors are not cached: the callers report them.
const MAX_ENTRIES = 64;
const cache = new Map<string, AST.Template>();

export function parseTemplate(content: string): AST.Template {
  const cached = cache.get(content);
  if (cached) return cached;
  const ast = preprocess(content, { mode: 'codemod' });
  cache.set(content, ast);
  if (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value as string);
  }
  return ast;
}
