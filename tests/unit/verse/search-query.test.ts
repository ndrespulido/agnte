import { describe, expect, it } from 'vitest';
import { searchTerms, toTsQuery } from '@/modules/verse/domain/search-query';

/**
 * The function standing between a text field and a query language.
 *
 * `to_tsquery` throws on malformed input, and a thrown query is a 500. The
 * whole point of this module is that nothing a person types ever reaches it as
 * syntax — so most of what is below is about punctuation, and the last block
 * is the one that matters: junk in, no operators out.
 */

describe('searchTerms', () => {
  it('splits on whitespace', () => {
    expect(searchTerms('dinner with friends')).toEqual(['dinner', 'with', 'friends']);
  });

  it('lowercases, because the stored vector is lowercase', () => {
    expect(searchTerms('Barcelona')).toEqual(['barcelona']);
  });

  /** Accented and non-Latin text is words, not punctuation. */
  it('keeps letters from any script', () => {
    expect(searchTerms('café mañana')).toEqual(['café', 'mañana']);
    expect(searchTerms('日本 ramen')).toEqual(['日本', 'ramen']);
  });

  it('keeps digits', () => {
    expect(searchTerms('flight BA2748')).toEqual(['flight', 'ba2748']);
  });

  /** Punctuation separates rather than joining: `a&b` is two words. */
  it('treats every operator character as a separator', () => {
    expect(searchTerms('a&b')).toEqual(['a', 'b']);
    expect(searchTerms('a|b')).toEqual(['a', 'b']);
    expect(searchTerms("tickets' olives")).toEqual(['tickets', 'olives']);
    expect(searchTerms('one-two')).toEqual(['one', 'two']);
  });

  it('is empty for text with no words in it', () => {
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
    expect(searchTerms('&&& ||| !!!')).toEqual([]);
  });
});

describe('toTsQuery', () => {
  it('is nothing when there is nothing to ask', () => {
    expect(toTsQuery('')).toBeNull();
    expect(toTsQuery('  ')).toBeNull();
    expect(toTsQuery('&&&')).toBeNull();
  });

  /**
   * The bug this file exists for. The field filters as you type, so a
   * whole-word matcher answers "nothing" to every keystroke until the last
   * letter lands — which reads as a search that does not work.
   */
  it('makes the word still being typed a prefix', () => {
    expect(toTsQuery('barcel')?.tsquery).toBe('barcel:*');
  });

  /**
   * Only the last. The earlier words are finished, and making them prefixes
   * would turn "cat food" into everything starting with "cat" — a different
   * question from the one asked.
   */
  it('leaves the finished words exact', () => {
    expect(toTsQuery('dinner barcel')?.tsquery).toBe('dinner & barcel:*');
    expect(toTsQuery('a b cd')?.tsquery).toBe('a & b & cd:*');
  });

  /**
   * Including the very first keystroke. Requiring two letters was the first
   * instinct and it is the same bug one letter earlier: typing `o` when the
   * timeline says "olives" must not answer "nothing".
   */
  it('prefixes even a single letter', () => {
    expect(toTsQuery('a')?.tsquery).toBe('a:*');
    expect(toTsQuery('de')?.tsquery).toBe('de:*');
  });

  it('reports the terms it used', () => {
    expect(toTsQuery('Dinner Barcel')?.terms).toEqual(['dinner', 'barcel']);
  });

  /**
   * Kept by hand from `websearch_to_tsquery`, because it worked before this
   * change and dropping a working feature while fixing a broken one is not a
   * trade anyone asked for.
   */
  it('excludes a word written with a leading dash', () => {
    const built = toTsQuery('red -car');
    expect(built?.terms).toEqual(['red']);
    expect(built?.excluded).toEqual(['car']);
    expect(built?.tsquery).toBe('red:* & !car');
  });

  /** A hyphen inside a word is not an exclusion. */
  it('does not read an internal hyphen as an exclusion', () => {
    const built = toTsQuery('one-two');
    expect(built?.excluded).toEqual([]);
    expect(built?.tsquery).toBe('one & two:*');
  });

  it('is still a query when only exclusions are given', () => {
    expect(toTsQuery('-car')?.tsquery).toBe('!car');
  });

  /** A bare dash is punctuation, not an operator with nothing to negate. */
  it('ignores a lone dash', () => {
    expect(toTsQuery('-')).toBeNull();
  });

  /**
   * The security-shaped case, and the reason nothing is escaped rather than
   * dropped: escaping is a thing to get subtly wrong.
   *
   * Every one of these is syntax `to_tsquery` would either act on or throw
   * over. None of it may survive into the query as anything but a lexeme.
   */
  it.each([
    '&',
    '|',
    '!',
    '(',
    ')',
    '<->',
    'a & !(b)',
    "'; DROP TABLE verse.verse; --",
    'a:*:*',
    '\\',
    'café & (mañana',
  ])('never emits an operator from typed text (%j)', (text) => {
    const built = toTsQuery(text);
    if (built === null) return;

    // The only operators present are the ones this module joined with, and the
    // single trailing `:*` it may have added.
    const withoutOurs = built.tsquery
      .replaceAll(' & ', ' ')
      .replaceAll('!', '')
      .replace(/:\*$/, '');
    expect(withoutOurs).toMatch(/^[\p{L}\p{N} ]*$/u);
  });

  /** A long ramble must not become a query with hundreds of clauses. */
  it('handles a lot of words without producing anything strange', () => {
    const built = toTsQuery(Array.from({ length: 50 }, (_, i) => `w${i}`).join(' '));
    expect(built?.terms).toHaveLength(50);
    expect(built?.tsquery.endsWith('w49:*')).toBe(true);
  });
});
