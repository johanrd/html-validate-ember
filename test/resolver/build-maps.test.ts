import { describe, it, expect } from 'vitest';
import { preprocess } from '@glimmer/syntax';

import { buildResolutionMaps } from '../../lib/resolver/build-maps.js';

// The Glint path (lib/glint.ts:applyResolution) records transparent
// resolutions as `componentTagMap.set(key, 'transparent')`. The no-Glint
// canonical resolver must mirror that for dotted invocations (which it
// always resolves transparent) so detectSuppressions' transparent-dotted
// suppression (Case D) fires identically in both modes.
describe('buildResolutionMaps: dotted invocations recorded as transparent', () => {
  it('records dotted invocations as transparent, with no attr entry', () => {
    const ast = preprocess('<B.Tr><B.Td>x</B.Td></B.Tr>', { mode: 'codemod' });
    const { componentTagMap, componentAttrMap } = buildResolutionMaps('/x/consumer.gts', ast);
    expect([...componentTagMap.values()]).toEqual(['transparent', 'transparent']);
    // Parity with applyResolution, which deletes the attr entry on transparent.
    expect(componentAttrMap.size).toBe(0);
  });

  it('records dotted cells nested inside a named block', () => {
    const ast = preprocess('<:body as |B|><B.Tr>x</B.Tr></:body>', { mode: 'codemod' });
    const { componentTagMap } = buildResolutionMaps('/x/consumer.gts', ast);
    // The `<:body>` named block is not a component; `<B.Tr>` is recorded.
    expect([...componentTagMap.values()]).toContain('transparent');
  });

  it('records lowercase-binder dotted invocations too (matches the Glint gate)', () => {
    const ast = preprocess('<b.Tr>x</b.Tr>', { mode: 'codemod' });
    const { componentTagMap } = buildResolutionMaps('/x/consumer.gts', ast);
    expect([...componentTagMap.values()]).toContain('transparent');
  });
});
