import { describe, expect, it } from 'vitest';
import { likePattern, searchTermsOf } from '@/modules/verse/domain/search-query';

/**
 * Turning typed text into substrings.
 *
 * Much smaller than the tsquery builder it replaced, because a substring
 * search has no syntax to parse — which was the point. What is left is the
 * splitting rule, exclusion, and making sure a person's own `%` stays a `%`.
 */

describe('searchTermsOf', () => {
  it('is nothing when there is nothing to ask', () => {
    expect(searchTermsOf('')).toBeNull();
    expect(searchTermsOf('   ')).toBeNull();
  });

  it('splits on whitespace, and every term must appear', () => {
    expect(searchTermsOf('dinner olives')?.terms).toEqual(['dinner', 'olives']);
  });

  /**
   * The reason this is a substring search at all. Chinese has no spaces, so
   * the split is a no-op and the phrase stays one term — and a substring match
   * can see inside it, which `to_tsvector` cannot.
   */
  it('keeps a Chinese phrase whole', () => {
    const built = searchTermsOf('巴塞罗那');
    expect(built?.terms).toEqual(['巴塞罗那']);
    expect(built?.patterns).toEqual(['%巴塞罗那%']);
  });

  it('keeps accented text as typed, for the database to fold', () => {
    expect(searchTermsOf('café mañana')?.terms).toEqual(['café', 'mañana']);
  });

  /** Nothing is a separator except whitespace: punctuation is searchable text. */
  it('does not split on punctuation', () => {
    expect(searchTermsOf("tickets' olives")?.terms).toEqual(["tickets'", 'olives']);
    expect(searchTermsOf('one-two')?.terms).toEqual(['one-two']);
  });

  it('excludes a word written with a leading dash', () => {
    const built = searchTermsOf('red -car');
    expect(built?.terms).toEqual(['red']);
    expect(built?.excluded).toEqual(['car']);
    expect(built?.excludedPatterns).toEqual(['%car%']);
  });

  it('is still a query when only exclusions are given', () => {
    expect(searchTermsOf('-car')?.excluded).toEqual(['car']);
  });

  it('ignores a lone dash', () => {
    expect(searchTermsOf('-')?.terms).toEqual(['-']);
  });

  /**
   * The one concession to what a search box teaches people to type. Not phrase
   * search — the quotes are dropped and both words must appear independently.
   */
  it('drops quotes rather than searching for them', () => {
    expect(searchTermsOf('"red bus"')?.terms).toEqual(['red', 'bus']);
    expect(searchTermsOf('"olives"')?.terms).toEqual(['olives']);
    expect(searchTermsOf('-"car"')?.excluded).toEqual(['car']);
  });

  it('leaves a quote in the middle of a term alone', () => {
    expect(searchTermsOf("don't")?.terms).toEqual(["don't"]);
    expect(searchTermsOf('a"b')?.terms).toEqual(['a"b']);
  });
});

describe('likePattern', () => {
  it('wraps the term so it matches anywhere', () => {
    expect(likePattern('oliv')).toBe('%oliv%');
  });

  /**
   * Someone typing `100%` is looking for "100%", not "100 followed by
   * anything". The wildcards belong to `LIKE`, not to them.
   */
  it('defangs the wildcards LIKE would otherwise act on', () => {
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
  });

  /**
   * The backslash goes first. Escaping it last would double-escape the
   * backslashes the other two rules introduce, and `%` would stop being
   * literal again.
   */
  it('escapes a literal backslash without eating the other escapes', () => {
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
    expect(likePattern('50%\\')).toBe('%50\\%\\\\%');
  });
});
