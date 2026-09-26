/**
 * Turning what a person types into a substring match (§8.2).
 *
 * This replaced a `tsvector` full-text search, and the reason is Chinese.
 * Postgres tokenises on whitespace, and Chinese has none — so
 * `to_tsvector('simple', '我今天去了巴塞罗那吃饭')` produces exactly one lexeme,
 * the whole sentence, and searching for 巴塞罗那 inside it matches nothing.
 * That is not a tuning problem; without a segmenting extension (`zhparser`,
 * `pg_jieba`, neither available on Neon) full-text search cannot see inside
 * Chinese text at all.
 *
 * A substring match has no such blind spot: it treats text as text. It is also
 * simply what most people mean by searching their own notes — find where I
 * wrote this — and it behaves the same in every script, which a per-language
 * stemming configuration never could.
 *
 * What is given up, stated plainly: stemming (`olives` will not find `olive`
 * in any language), and ranking. Neither was working for Chinese anyway, and
 * results are ordered newest-first rather than by relevance.
 */

/**
 * `LIKE` wildcards, escaped so typed text is only ever literal.
 *
 * The same principle the tsquery builder had, for a much smaller surface: a
 * person typing `100%` is looking for "100%", not for "100 followed by
 * anything". `\` goes first — escaping it after the others would double-escape
 * the backslashes they introduce.
 */
const escapeLike = (term: string): string =>
  term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

export interface SearchTerms {
  /** Substrings that must all appear, in the order they were typed. */
  readonly terms: readonly string[];
  /** Substrings that must not appear. */
  readonly excluded: readonly string[];
  /** The same, as `%term%` patterns ready for `ILIKE`. */
  readonly patterns: readonly string[];
  readonly excludedPatterns: readonly string[];
}

/**
 * The one character that is not taken literally: a wrapping quote.
 *
 * Not a phrase parser — `"red bus"` becomes `red` and `bus`, both of which
 * must appear, which is not the same promise. It exists because a search box
 * teaches people to type quotes, and a literal `"` makes the term unmatchable:
 * `%"red%` finds nothing in "the red bus". Answering a reasonable query with
 * silence is the exact bug this change set out to fix, so the quote is dropped
 * rather than searched for.
 *
 * A quote at either end of a term goes, which is what `"red bus"` needs —
 * there the quotes land on two different terms, so a whole-string rule would
 * not see them as a pair. The cost, stated rather than hidden: `5"` searches
 * for `5`, so an inch mark cannot be searched for at the end of a word. That
 * is the trade, and it falls the right way round.
 */
const stripQuotes = (term: string): string => term.replace(/^"|"$/g, '');

/** `%term%`, with the term's own wildcards defanged. */
export const likePattern = (term: string): string => `%${escapeLike(term)}%`;

/**
 * The terms for a piece of typed text, or null when there is nothing to ask.
 *
 * Split on whitespace, and **every** term must appear somewhere in the verse.
 * Splitting rather than matching the whole string as one substring is the one
 * concession to convenience: "dinner olives" should find a note saying "olives
 * at dinner", and requiring the exact phrase would not. For Chinese, which has
 * no spaces, the split is a no-op and the whole phrase is one term — so the
 * same rule reads correctly in every language.
 *
 * `-word` excludes, carried over from the full-text version because it worked
 * and people rely on what worked.
 *
 * Nothing else is syntax: no operators, no prefix markers, and no phrase
 * search — a substring match has nothing to parse, which is the point. A
 * wrapping quote is *removed* rather than honoured (see `stripQuotes`), which
 * is not the same as supporting one.
 */
export function searchTermsOf(text: string): SearchTerms | null {
  const terms: string[] = [];
  const excluded: string[] = [];

  for (const raw of text.split(/\s+/)) {
    // A lone `-` is punctuation, not an exclusion with nothing to exclude.
    const negated = raw.startsWith('-') && raw.length > 1;
    const term = stripQuotes(negated ? raw.slice(1) : raw).trim();
    if (term === '') continue;

    (negated ? excluded : terms).push(term);
  }

  if (terms.length === 0 && excluded.length === 0) return null;

  return {
    terms,
    excluded,
    patterns: terms.map(likePattern),
    excludedPatterns: excluded.map(likePattern),
  };
}
