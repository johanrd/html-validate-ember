// Two template-only components in expression form without a trailing
// semicolon. Blanking the templates before the TS parse leaves each
// `export const X = ` with no initializer, so the statement's range
// ends before its template block.
export const Bar = <template>
  <div class='bar'>{{yield}}</div>
</template>

export const Baz = <template>
  <span class='baz'>{{yield}}</span>
</template>
