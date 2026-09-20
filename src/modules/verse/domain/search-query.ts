/**
 * Turning what a person types into a `tsquery` (§8.2).
 *
 * This exists because of one hard trade. `websearch_to_tsquery` is forgiving —
 * it takes quoted phrases, `or`, a leading `-`, and it never throws, so a typo
 * can never become a 500. What it cannot do is prefix matching.
 *
 * Prefix matching is not a nicety here. The search field filters as you type,
 * so every keystroke before the last one is a partial word: someone typing
 * "barcelona" asks for `b`, `ba`, `bar`… and a whole-word matcher answers
 * "nothing" to all of them. The search reads as broken until the instant the
 * final letter lands. That is the bug this file fixes.
 *
 * `to_tsquery` does prefix matching with `word:*` — and *throws* on malformed
 * input. A bare `&`, an unbalanced bracket, a leading `|`: syntax error, which
 * reaches the caller as a 500. So the text can never be handed to it directly.
 * Everything below exists to guarantee that what we pass is something
 * `to_tsquery` cannot object to: a list of lexemes we built ourselves, joined
 * by a single operator we chose.
 *
 * The rule is: **nothing the person typed survives as syntax.** Their
 * characters only ever appear inside a lexeme, and anything that could be an
 * operator is dropped rather than escaped — escaping is a thing to get subtly
 * wrong, and dropping is not.
 */

/**
 * Characters that can carry meaning to `to_tsquery`, plus whitespace.
 *
 * Everything in here is a separator, so `a&b` searches for `a` and `b` rather
 * than being read as the AND operator. Unicode letters and digits are kept, so
 * accented and non-Latin text survives — `café` and `日本` are words, not
 * punctuation.
 */
const SEPARATORS = /[^\p{L}\p{N}]+/u;

export interface SearchTerms {
  /** The words that must be present, in the order they were typed. */
  readonly terms: readonly string[];
  /** The words that must be absent. */
  readonly excluded: readonly string[];
  /** The `to_tsquery` string, safe to interpolate as a parameter. */
  readonly tsquery: string;
}

/**
 * Splits typed text into the lexemes to search for.
 *
 * Exported for its own test: this is the function standing between a text
 * field and a query language, so its edges are worth pinning individually
 * rather than only through a database.
 */
export function searchTerms(text: string): readonly string[] {
  return text
    .split(SEPARATORS)
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);
}

/**
 * The query for a piece of typed text, or null when there is nothing to ask.
 *
 * Every term is ANDed, and the **last** term is a prefix. Only the last,
 * deliberately: it is the word still being typed, and the ones before it are
 * finished words the person would expect to match exactly. Making them all
 * prefixes would quietly turn "cat food" into a search for everything starting
 * with "cat", which is a different question.
 *
 * Even a single letter is a prefix. The first instinct was to require two,
 * on the grounds that `a:*` matches most of a timeline — but that is what a
 * one-letter filter *means*, and the person watching it narrow as they type
 * can see that. Answering "nothing" to the first keystroke is the same
 * complaint this file exists to fix, one letter earlier.
 *
 * The cost is a wide index scan on a common letter. On a personal timeline
 * that is small, and the limit caps what comes back; if it ever stops being
 * small, the answer is a minimum length *with* a message saying so, not
 * silence.
 *
 * **`-word` excludes**, which is the one piece of `websearch_to_tsquery`'s
 * syntax kept by hand. It was already supported and already tested, and
 * dropping a working feature while fixing a broken one is not a trade anyone
 * asked for. Phrase search (`"red bus"`) is *not* kept — see the note below.
 */
export function toTsQuery(text: string): SearchTerms | null {
  const terms: string[] = [];
  const excluded: string[] = [];

  /*
   * Split on whitespace first, so a leading `-` can be seen before punctuation
   * is stripped. `SEPARATORS` would eat it, and `-car` would become an
   * ordinary `car` — the exact opposite of what was asked for.
   *
   * A hyphen *inside* a word is not an exclusion: `one-two` is one raw token
   * that does not start with `-`, so it sanitises into two ordinary words.
   */
  for (const raw of text.split(/\s+/)) {
    const negated = raw.startsWith('-') && raw.length > 1;
    const words = searchTerms(negated ? raw.slice(1) : raw);
    (negated ? excluded : terms).push(...words);
  }

  if (terms.length === 0 && excluded.length === 0) return null;

  const positives = terms.map((term, index) =>
    index === terms.length - 1 ? `${term}:*` : term,
  );

  const clauses = [...positives, ...excluded.map((term) => `!${term}`)];

  return { terms, excluded, tsquery: clauses.join(' & ') };
}
