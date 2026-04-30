// Verifies that TS-flavored block-param annotations are stripped
// before Glimmer parses — including the complex shapes a regex strip
// can't handle:
//
//   - Multi-param + comma:    `as |a: A, b: B|`
//   - Object types:           `as |x: { a: number }|`
//   - Parenthesized:          `as |x: (A | B)|`
//   - Union (raw):            `as |x: A | B|`
//   - Generic with comma:     `as |x: Map<string, number>|`
//   - Array:                  `as |x: T[]|`
//
// All of these would silently un-parse the entire template without the
// strip. The body has a duplicate-id pattern that should still surface,
// proving the body was actually walked.
interface Row { id: string; label: string }
interface Col { name: string }
const items: Row[] = [];

export default <template>
  {{#each items as |item: Row, idx: number|}}
    {{#each item.label as |c: { code: number }|}}
      {{#each items as |x: (Row | Col)|}}
        {{#each items as |x: Map<string, number>|}}
          <input id='dup' name='x{{idx}}' />
          <input id='dup' name='y{{idx}}' />
        {{/each}}
      {{/each}}
    {{/each}}
  {{/each}}
</template>;
