// Curated element sets shared between blank.ts and lib/glint.ts.
//
// STRUCTURAL_CHILD_TAGS is a curated set — NOT a direct derivation from
// html-validate's HTML5 schema. The pure derivation (any tag named as a
// child in some `permittedContent`) is too wide: it includes flow content
// like `<div>`/`<p>`, `<button>`, `<source>`, `<track>` — suppressing on
// those would mask real violations.
//
// The narrow criterion: tags whose runtime behavior REQUIRES a specific
// structural parent OR INTERPOSES a structural child (a tabs component may
// interpose `<li>` in `<ul>`; fieldset may interpose `<legend>` from a
// yielded slot; etc.). That's an empirical pattern, not a clean function
// of `permittedContent`.
//
// The lists are validated at module load against the live HTML5 schema in
// blank.ts. If a future html-validate revision stops listing one of these
// as a named permittedContent entry the boot assertion surfaces it as a
// build-time error rather than silent suppression breakage.
export const STRUCTURAL_CHILD_TAGS: ReadonlySet<string> = new Set([
  'option', 'optgroup', 'th', 'td', 'tr', 'thead', 'tbody', 'tfoot',
  'caption', 'colgroup', 'col', 'li', 'legend', 'summary',
]);
